"""
FASE 4: OBSERVER AGENT - GUARDIÁN ESTRICTO
============================================
Convertido a validador estricto, no sugiere creativamente.
Output: {estado_valido: bool, errores: [], warnings: []}
REGLA: Si estado_valido=false, el grafo NO avanza.
"""

from typing import Dict, Any, Optional, List
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage
import json
import logging

from ..config import get_settings, get_observer_model
from ..schemas.vendor_state import (
    ObserverOutput, ObserverValidation, 
    CommercialState, VendorOutput, IntencionCliente
)

logger = logging.getLogger(__name__)


OBSERVER_VALIDATOR_PROMPT = """Eres el "Observer Agent" (Cerebro 2) - VALIDADOR ESTRICTO del sistema multi-agente.

## TU ROL:
Validar que el estado de la conversación sea coherente y que se pueda avanzar.
NO sugieres mejoras creativas. Solo VALIDAS.

## QUÉ VALIDAS:
1. Coherencia entre intención detectada y respuesta
2. Completitud de datos antes de acciones críticas
3. Secuencia lógica del proceso de venta
4. Datos extraídos correctamente

## FORMATO DE RESPUESTA OBLIGATORIO:
```json
{
  "estado_valido": true/false,
  "errores": ["errores críticos que impiden avanzar"],
  "warnings": ["advertencias que no impiden avanzar"],
  "validaciones_pasadas": ["qué validaciones pasaron correctamente"],
  "sugerencia_correccion": "si hay error, cómo corregirlo"
}
```

## ERRORES CRÍTICOS (estado_valido=false):
- Intención de compra sin productos identificados
- Intento de generar pago sin productos confirmados
- Datos del cliente inconsistentes
- Respuesta contradice la intención detectada

## WARNINGS (no impiden avanzar):
- Podría haber más contexto
- La confianza es baja pero aceptable
- Falta información opcional

## REGLA SUPREMA:
Si detectas un error crítico, estado_valido DEBE ser false.
El sistema NO avanzará si estado_valido=false.
"""


OBSERVER_LEGACY_PROMPT = """Eres el "Observer Agent" (Cerebro 2) de un sistema multi-agente de ventas.

## TU ROL:
Analizar la conversación entre el cliente y el agente de ventas para detectar:
1. Fallas en la respuesta del agente
2. Objeciones del cliente que no fueron manejadas
3. Oportunidades de mejora

## FORMATO DE RESPUESTA OBLIGATORIO:
Responde ÚNICAMENTE con un JSON válido:
```json
{
  "fallas": ["lista de errores o problemas en la respuesta del agente"],
  "objeciones": ["objeciones del cliente que detectaste"],
  "recomendaciones": ["sugerencias para mejorar futuras respuestas"]
}
```

## EJEMPLOS DE FALLAS:
- "No mencionó el precio cuando el cliente lo preguntó"
- "No ofreció alternativas cuando el producto estaba agotado"
- "Respuesta demasiado larga y confusa"
- "No detectó la intención de compra del cliente"

## EJEMPLOS DE OBJECIONES:
- "Cliente mencionó que el precio es alto"
- "Cliente tiene dudas sobre el tiempo de envío"
- "Cliente quiere comparar con otras opciones"

## EJEMPLOS DE RECOMENDACIONES:
- "Cuando el cliente pregunte por precio, mencionar también formas de pago"
- "Si el producto está agotado, ofrecer similar inmediatamente"
- "Detectar señales de compra y ofrecer link de pago"

Si no hay fallas, objeciones o recomendaciones, devuelve listas vacías.
"""


class ObserverAgent:
    def __init__(self):
        self.settings = get_settings()
        self._current_model = get_observer_model()
        self.llm = ChatOpenAI(
            api_key=self.settings.openai_api_key,
            model=self._current_model,
            temperature=0.3
        )
    
    def _ensure_model_current(self):
        """Check if model config changed and refresh if needed."""
        platform_model = get_observer_model()
        if platform_model != self._current_model:
            logger.info(f"ObserverAgent model changed: {self._current_model} -> {platform_model}")
            self._current_model = platform_model
            self.llm = ChatOpenAI(
                api_key=self.settings.openai_api_key,
                model=platform_model,
                temperature=0.3
            )
    
    async def validate(
        self,
        vendor_output: VendorOutput,
        commercial_state: Optional[CommercialState],
        user_message: str,
        conversation_context: List[Dict[str, str]]
    ) -> tuple[ObserverValidation, int]:
        """
        FASE 4: Método principal del Observer.
        Valida el estado y retorna ObserverValidation.
        Si estado_valido=false, el grafo NO avanza.
        """
        self._ensure_model_current()
        
        validation_prompt = f"""Valida la siguiente situación:

## MENSAJE DEL CLIENTE:
{user_message}

## INTENCIÓN DETECTADA:
{vendor_output.intencion.value}

## RESPUESTA PROPUESTA:
{vendor_output.mensaje}

## ENTIDADES DETECTADAS:
{json.dumps(vendor_output.entidades_detectadas, ensure_ascii=False)}

## CONFIANZA DEL VENDOR:
{vendor_output.confianza}

## REQUIERE TOOL:
{vendor_output.requiere_tool} - Tool sugerida: {vendor_output.tool_sugerida}

## ESTADO COMERCIAL ACTUAL:
{commercial_state.model_dump() if commercial_state else "No disponible"}

## CONTEXTO DE CONVERSACIÓN:
{self._format_context(conversation_context)}

Valida si todo es coherente y si se puede avanzar.
"""
        
        messages = [
            SystemMessage(content=OBSERVER_VALIDATOR_PROMPT),
            HumanMessage(content=validation_prompt)
        ]
        
        try:
            response = self.llm.invoke(messages)
            
            tokens_used = 0
            if hasattr(response, "response_metadata"):
                usage = response.response_metadata.get("token_usage", {})
                tokens_used = usage.get("total_tokens", 0)
            
            validation = self._parse_validation(response.content)
            
            self._apply_hardcoded_rules(validation, vendor_output, commercial_state)
            
            return validation, tokens_used
            
        except Exception as e:
            logger.error(f"Observer validate error: {e}")
            return ObserverValidation(
                estado_valido=True,
                warnings=["No se pudo ejecutar validación completa"]
            ), 0
    
    def _apply_hardcoded_rules(
        self,
        validation: ObserverValidation,
        vendor_output: VendorOutput,
        commercial_state: Optional[CommercialState]
    ) -> None:
        """Aplica reglas de validación hardcodeadas que no dependen del LLM."""
        
        if vendor_output.tool_sugerida == "payment":
            if commercial_state and not commercial_state.productos_confirmados:
                validation.estado_valido = False
                validation.errores.append(
                    "REGLA: No se puede generar pago sin productos confirmados"
                )
            
            if vendor_output.intencion != IntencionCliente.CONFIRMACION_COMPRA:
                validation.warnings.append(
                    "Sugiere payment pero la intención no es confirmacion_compra"
                )
        
        if vendor_output.confianza < 0.3:
            validation.warnings.append(
                f"Confianza muy baja ({vendor_output.confianza}), considerar pedir más información"
            )
        
        if vendor_output.requiere_tool and not vendor_output.tool_sugerida:
            validation.warnings.append(
                "Indica requiere_tool=true pero no sugiere qué tool"
            )
    
    def _parse_validation(self, content: str) -> ObserverValidation:
        """Parse response into ObserverValidation."""
        try:
            content = content.strip()
            if content.startswith("```json"):
                content = content[7:]
            if content.startswith("```"):
                content = content[3:]
            if content.endswith("```"):
                content = content[:-3]
            content = content.strip()
            
            data = json.loads(content)
            
            return ObserverValidation(
                estado_valido=data.get("estado_valido", True),
                errores=data.get("errores", []),
                warnings=data.get("warnings", []),
                validaciones_pasadas=data.get("validaciones_pasadas", []),
                sugerencia_correccion=data.get("sugerencia_correccion")
            )
            
        except json.JSONDecodeError as e:
            logger.warning(f"Could not parse observer validation: {e}")
            return ObserverValidation(
                estado_valido=True,
                warnings=["No se pudo parsear respuesta del validador"]
            )
    
    def _format_context(self, context: List[Dict[str, str]]) -> str:
        """Format conversation context for the prompt."""
        text = ""
        for msg in context[-5:]:
            role = "Cliente" if msg.get("role") == "user" else "Agente"
            text += f"{role}: {msg.get('content', '')}\n"
        return text
    
    async def analyze(
        self,
        user_message: str,
        agent_response: str,
        conversation_context: List[Dict[str, str]]
    ) -> tuple[ObserverOutput, int]:
        """Legacy method for backward compatibility."""
        context_text = ""
        for msg in conversation_context[-5:]:
            role = "Cliente" if msg.get("role") == "user" else "Agente"
            context_text += f"{role}: {msg.get('content', '')}\n"
        
        analysis_prompt = f"""Analiza esta interacción:

## CONTEXTO PREVIO:
{context_text}

## MENSAJE DEL CLIENTE:
{user_message}

## RESPUESTA DEL AGENTE:
{agent_response}

Proporciona tu análisis en el formato JSON especificado.
"""
        
        messages = [
            SystemMessage(content=OBSERVER_LEGACY_PROMPT),
            HumanMessage(content=analysis_prompt)
        ]
        
        try:
            response = self.llm.invoke(messages)
            
            tokens_used = 0
            if hasattr(response, "response_metadata"):
                usage = response.response_metadata.get("token_usage", {})
                tokens_used = usage.get("total_tokens", 0)
            
            output = self._parse_response(response.content)
            return output, tokens_used
            
        except Exception as e:
            logger.error(f"Observer agent error: {e}")
            return ObserverOutput(), 0
    
    def _parse_response(self, content: str) -> ObserverOutput:
        """Legacy parser for backward compatibility."""
        try:
            content = content.strip()
            if content.startswith("```json"):
                content = content[7:]
            if content.startswith("```"):
                content = content[3:]
            if content.endswith("```"):
                content = content[:-3]
            content = content.strip()
            
            data = json.loads(content)
            
            return ObserverOutput(
                fallas=data.get("fallas", []),
                objeciones=data.get("objeciones", []),
                recomendaciones=data.get("recomendaciones", [])
            )
            
        except json.JSONDecodeError as e:
            logger.warning(f"Could not parse observer response: {e}")
            return ObserverOutput()


_observer_agent: Optional[ObserverAgent] = None

def get_observer_agent() -> ObserverAgent:
    global _observer_agent
    if _observer_agent is None:
        _observer_agent = ObserverAgent()
    return _observer_agent

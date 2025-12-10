from typing import Dict, Any, Optional, List
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage
import json
import logging

from ..config import get_settings
from ..schemas.vendor_state import ObserverOutput

logger = logging.getLogger(__name__)


OBSERVER_SYSTEM_PROMPT = """Eres el "Observer Agent" (Cerebro 2) de un sistema multi-agente de ventas.

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
        self.llm = ChatOpenAI(
            api_key=self.settings.openai_api_key,
            model="gpt-4o-mini",
            temperature=0.3
        )
    
    async def analyze(
        self,
        user_message: str,
        agent_response: str,
        conversation_context: List[Dict[str, str]]
    ) -> tuple[ObserverOutput, int]:
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
            SystemMessage(content=OBSERVER_SYSTEM_PROMPT),
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

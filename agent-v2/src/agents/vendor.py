from typing import Dict, Any, Optional, List
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
import json
import logging
from datetime import datetime
import pytz

from ..config import get_settings
from ..schemas.business_profile import BusinessProfile
from ..schemas.vendor_state import VendorState, AgentAction, ActionType

logger = logging.getLogger(__name__)


def get_current_time_formatted(timezone: str) -> str:
    try:
        tz = pytz.timezone(timezone)
    except:
        tz = pytz.timezone("America/Lima")
    
    now = datetime.now(tz)
    
    days_es = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]
    months_es = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", 
                 "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"]
    
    day_name = days_es[now.weekday()]
    month_name = months_es[now.month - 1]
    
    return f"{day_name} {now.day} de {month_name} {now.year}, {now.strftime('%H:%M')}"


def build_vendor_system_prompt(
    profile: BusinessProfile,
    memory: Dict[str, Any],
    dynamic_rules: list,
    current_time: str,
    tools_available: list,
    knowledge_context: Optional[str] = None,
    observer_feedback: Optional[str] = None
) -> str:
    prompt = f"""Eres un agente de ventas profesional para {profile.business_name}.

FECHA Y HORA ACTUAL: {current_time}

## TU ROL:
Eres el "Vendor Agent" (Cerebro 1) de un sistema multi-agente. Tu trabajo es:
1. Interpretar el mensaje del cliente
2. Decidir si responder directamente o usar una herramienta
3. Consultar la memoria del lead para contexto
4. Aplicar las políticas del negocio
5. Retornar SIEMPRE un JSON estructurado

## FORMATO DE RESPUESTA OBLIGATORIO:
Debes responder ÚNICAMENTE con un JSON válido en este formato:
```json
{{
  "accion": "respuesta" | "tool",
  "mensaje": "tu mensaje al cliente (solo si accion es 'respuesta')",
  "nombre_tool": "search_product" | "payment" | "followup" | "media" | "crm" | "search_knowledge" | null,
  "input_tool": {{...}} 
}}
```
"""

    if observer_feedback:
        prompt += f"""
## CORRECCIÓN DEL SISTEMA (IMPORTANTE):
{observer_feedback}
Por favor, corrige tu respuesta anterior considerando este feedback.

"""

    prompt += "## HERRAMIENTAS DISPONIBLES:\n"
    for tool in tools_available:
        prompt += f"- **{tool['name']}**: {tool['description']}\n"

    prompt += """
## CUÁNDO USAR CADA HERRAMIENTA:
- **search_product**: Cuando el cliente pregunta por un producto específico o quiere ver opciones
- **search_knowledge**: Cuando el cliente pregunta algo que podría estar en la documentación del negocio
- **payment**: Cuando el cliente confirma que quiere comprar algo
- **followup**: Cuando detectas que el cliente necesita tiempo para decidir
- **media**: Cuando necesitas enviar una imagen de producto al cliente
- **crm**: Para actualizar el estado del lead (etapa, tags, intención)

"""

    if knowledge_context:
        prompt += f"""## CONTEXTO DE LA BASE DE CONOCIMIENTO:
{knowledge_context}

Usa esta información para responder preguntas del cliente cuando sea relevante.

"""

    if profile.custom_prompt:
        prompt += f"""## INSTRUCCIONES DEL NEGOCIO:
{profile.custom_prompt}

"""

    if profile.products:
        prompt += f"""## PRODUCTOS DISPONIBLES ({len(profile.products)} productos):
"""
        for p in profile.products[:15]:
            stock_info = f" [Stock: {p.stock}]" if p.stock is not None else ""
            prompt += f"- [ID:{p.id}] {p.name}: {profile.currency_symbol}{p.price}{stock_info}\n"
        if len(profile.products) > 15:
            prompt += f"... y {len(profile.products) - 15} productos más (usa search_product para buscar)\n"

    if profile.policies:
        prompt += f"""
## POLÍTICAS:
"""
        if profile.policies.shipping:
            prompt += f"- Envíos: {profile.policies.shipping}\n"
        if profile.policies.refund:
            prompt += f"- Devoluciones: {profile.policies.refund}\n"
        if profile.policies.brand_voice:
            prompt += f"- Tono: {profile.policies.brand_voice}\n"

    if memory:
        prompt += f"""
## MEMORIA DEL LEAD:
- Etapa actual: {memory.get('current_stage', 'nuevo')}
- Productos vistos: {', '.join(memory.get('products_viewed', [])) or 'ninguno'}
- Preferencias detectadas: {', '.join(memory.get('detected_preferences', [])) or 'ninguna'}
- Objeciones previas: {', '.join(memory.get('objections', [])) or 'ninguna'}
- Datos recopilados: {json.dumps(memory.get('collected_data', {}), ensure_ascii=False) or 'ninguno'}
"""

    if dynamic_rules:
        prompt += f"""
## REGLAS APRENDIDAS (aplícalas):
"""
        for rule in dynamic_rules[-10:]:
            prompt += f"- {rule}\n"

    prompt += """
## DIRECTRICES FINALES:
1. Sé profesional pero amigable
2. Sé conciso y directo
3. Si no tienes información, usa search_knowledge o indica honestamente que no sabes
4. Usa emojis de forma moderada
5. SIEMPRE responde con el JSON estructurado
6. Si el cliente pregunta algo fuera de tu conocimiento, intenta usar search_knowledge primero

RECUERDA: Tu respuesta debe ser ÚNICAMENTE el JSON estructurado, nada más.
"""

    return prompt


class VendorAgent:
    def __init__(self):
        self.settings = get_settings()
        self.llm = ChatOpenAI(
            api_key=self.settings.openai_api_key,
            model=self.settings.vendor_model,
            temperature=0.7
        )
        self.refine_llm = ChatOpenAI(
            api_key=self.settings.openai_api_key,
            model=self.settings.refine_model,
            temperature=0.5
        )
    
    async def process(
        self,
        current_message: str,
        conversation_history: list,
        business_profile: BusinessProfile,
        lead_memory: Dict[str, Any],
        dynamic_rules: list,
        tools_available: list,
        sender_name: Optional[str] = None,
        knowledge_context: Optional[str] = None,
        observer_feedback: Optional[str] = None
    ) -> tuple[AgentAction, int]:
        current_time = get_current_time_formatted(business_profile.timezone)
        
        system_prompt = build_vendor_system_prompt(
            profile=business_profile,
            memory=lead_memory,
            dynamic_rules=dynamic_rules,
            current_time=current_time,
            tools_available=tools_available,
            knowledge_context=knowledge_context,
            observer_feedback=observer_feedback
        )
        
        messages = [SystemMessage(content=system_prompt)]
        
        history_limit = 8
        for msg in conversation_history[-history_limit:]:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "user":
                messages.append(HumanMessage(content=content))
            elif role == "assistant":
                messages.append(AIMessage(content=content))
        
        user_msg = current_message
        if sender_name:
            user_msg = f"[{sender_name}]: {current_message}"
        messages.append(HumanMessage(content=user_msg))
        
        try:
            response = self.llm.invoke(messages)
            
            tokens_used = 0
            if hasattr(response, "response_metadata"):
                usage = response.response_metadata.get("token_usage", {})
                tokens_used = usage.get("total_tokens", 0)
            
            action = self._parse_response(response.content)
            
            return action, tokens_used
            
        except Exception as e:
            logger.error(f"Vendor agent error: {e}")
            return AgentAction(
                accion=ActionType.RESPONSE,
                mensaje="Lo siento, tuve un problema procesando tu mensaje. ¿Podrías repetirlo?"
            ), 0
    
    async def refine_with_tool_result(
        self,
        original_message: str,
        tool_name: str,
        tool_result: str,
        current_message: str,
        business_profile: BusinessProfile,
        tool_failed: bool = False
    ) -> tuple[str, int]:
        """Second pass: Vendor reasons about tool result to craft better response"""
        
        if tool_failed:
            refine_prompt = f"""Eres un agente de ventas para {business_profile.business_name}.

El cliente preguntó: "{current_message}"

Intentaste usar la herramienta "{tool_name}" pero falló con este error:
{tool_result}

Genera una respuesta NATURAL y CONVERSACIONAL para el cliente que:
1. NO menciones errores técnicos ni herramientas internas
2. Ofrece una alternativa o pide más información si es necesario
3. Mantén un tono profesional y amigable
4. Si no puedes ayudar directamente, ofrece asistencia manual

Responde SOLO con el mensaje para el cliente, sin JSON ni formato especial.
"""
        else:
            refine_prompt = f"""Eres un agente de ventas para {business_profile.business_name}.

El cliente preguntó: "{current_message}"

Ejecutaste la herramienta "{tool_name}" y obtuviste este resultado:
{tool_result}

Tu mensaje original era: "{original_message or 'ninguno'}"

Ahora, genera una respuesta NATURAL y CONVERSACIONAL para el cliente que:
1. Integre la información del resultado de la herramienta
2. Sea amigable y profesional
3. Guíe al cliente hacia el siguiente paso (si aplica)
4. NO menciones que usaste herramientas o sistemas internos

Responde SOLO con el mensaje para el cliente, sin JSON ni formato especial.
"""
        
        messages = [HumanMessage(content=refine_prompt)]
        
        try:
            response = self.refine_llm.invoke(messages)
            
            tokens_used = 0
            if hasattr(response, "response_metadata"):
                usage = response.response_metadata.get("token_usage", {})
                tokens_used = usage.get("total_tokens", 0)
            
            return response.content.strip(), tokens_used
            
        except Exception as e:
            logger.error(f"Vendor refine error: {e}")
            if original_message:
                return f"{original_message}\n\n{tool_result}", 0
            return tool_result, 0
    
    def _parse_response(self, content: str) -> AgentAction:
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
            
            accion_str = data.get("accion", "respuesta")
            accion = ActionType.TOOL if accion_str == "tool" else ActionType.RESPONSE
            
            return AgentAction(
                accion=accion,
                mensaje=data.get("mensaje"),
                nombre_tool=data.get("nombre_tool"),
                input_tool=data.get("input_tool")
            )
            
        except json.JSONDecodeError as e:
            logger.warning(f"Could not parse vendor response as JSON: {e}")
            return AgentAction(
                accion=ActionType.RESPONSE,
                mensaje=content
            )


_vendor_agent: Optional[VendorAgent] = None

def get_vendor_agent() -> VendorAgent:
    global _vendor_agent
    if _vendor_agent is None:
        _vendor_agent = VendorAgent()
    return _vendor_agent

from typing import Dict, Any, Optional, List
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage
import json
import logging
import redis

from ..config import get_settings
from ..schemas.vendor_state import ObserverOutput, RefinerOutput

logger = logging.getLogger(__name__)


REFINER_SYSTEM_PROMPT = """Eres el "Refiner Agent" (Cerebro 3) de un sistema multi-agente de ventas.

## TU ROL:
Tomar los insights del Observer Agent y generar reglas nuevas que mejoren el comportamiento del Vendor Agent en futuras conversaciones.

## FORMATO DE RESPUESTA OBLIGATORIO:
Responde ÚNICAMENTE con un JSON válido:
```json
{
  "nuevas_reglas": ["reglas claras y accionables para el vendor"],
  "nuevas_respuestas": [{"situacion": "descripción", "respuesta_sugerida": "texto"}]
}
```

## EJEMPLOS DE REGLAS:
- "Siempre mencionar formas de pago cuando se hable de precios"
- "Si el cliente dice 'es caro', ofrecer descuento o plan de pagos"
- "Ante preguntas de disponibilidad, verificar stock antes de responder"
- "Si el cliente no responde en 2 mensajes, usar followup"

## EJEMPLOS DE RESPUESTAS SUGERIDAS:
{
  "situacion": "Cliente dice que el precio es alto",
  "respuesta_sugerida": "Entiendo tu preocupación por el precio. Tenemos opciones de pago en cuotas sin interés. ¿Te gustaría conocer los detalles?"
}

## IMPORTANTE:
- Solo genera reglas si hay fallas o recomendaciones significativas
- Las reglas deben ser específicas y accionables
- No repitas reglas que ya existan
- Si no hay nada que mejorar, devuelve listas vacías
"""


def _get_redis_client() -> Optional[redis.Redis]:
    settings = get_settings()
    if settings.redis_url:
        try:
            client = redis.from_url(settings.redis_url, decode_responses=True)
            client.ping()
            return client
        except Exception as e:
            logger.warning(f"Redis connection failed: {e}")
    return None


class RefinerAgent:
    def __init__(self):
        self.settings = get_settings()
        self.llm = ChatOpenAI(
            api_key=self.settings.openai_api_key,
            model=self.settings.refiner_model,
            temperature=0.3
        )
    
    async def refine(
        self,
        observer_output: ObserverOutput,
        business_id: str,
        existing_rules: List[str]
    ) -> tuple[RefinerOutput, int]:
        if not observer_output.fallas and not observer_output.recomendaciones:
            return RefinerOutput(), 0
        
        existing_rules_text = "\n".join([f"- {rule}" for rule in existing_rules[-20:]]) if existing_rules else "Ninguna aún"
        
        refine_prompt = f"""## ANÁLISIS DEL OBSERVER:
Fallas detectadas: {json.dumps(observer_output.fallas, ensure_ascii=False)}
Objeciones del cliente: {json.dumps(observer_output.objeciones, ensure_ascii=False)}
Recomendaciones: {json.dumps(observer_output.recomendaciones, ensure_ascii=False)}

## REGLAS EXISTENTES:
{existing_rules_text}

Genera nuevas reglas basadas en este análisis. No repitas reglas existentes.
"""
        
        messages = [
            SystemMessage(content=REFINER_SYSTEM_PROMPT),
            HumanMessage(content=refine_prompt)
        ]
        
        try:
            response = self.llm.invoke(messages)
            
            tokens_used = 0
            if hasattr(response, "response_metadata"):
                usage = response.response_metadata.get("token_usage", {})
                tokens_used = usage.get("total_tokens", 0)
            
            output = self._parse_response(response.content)
            
            if output.nuevas_reglas or output.nuevas_respuestas:
                self._save_learning(business_id, output)
            
            return output, tokens_used
            
        except Exception as e:
            logger.error(f"Refiner agent error: {e}")
            return RefinerOutput(), 0
    
    def _parse_response(self, content: str) -> RefinerOutput:
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
            
            return RefinerOutput(
                nuevas_reglas=data.get("nuevas_reglas", []),
                nuevas_respuestas=data.get("nuevas_respuestas", [])
            )
            
        except json.JSONDecodeError as e:
            logger.warning(f"Could not parse refiner response: {e}")
            return RefinerOutput()
    
    def _save_learning(self, business_id: str, output: RefinerOutput) -> None:
        """Save learning to Redis for persistence"""
        client = _get_redis_client()
        
        if client is None:
            logger.warning("Redis not available, learning not saved")
            return
        
        try:
            key = f"agent_v2:rules:{business_id}"
            
            existing_data = {"reglas": [], "respuestas": []}
            existing_raw = client.get(key)
            if existing_raw:
                existing_data = json.loads(existing_raw)
            
            for rule in output.nuevas_reglas:
                if rule not in existing_data["reglas"]:
                    existing_data["reglas"].append(rule)
            
            for resp in output.nuevas_respuestas:
                if resp not in existing_data["respuestas"]:
                    existing_data["respuestas"].append(resp)
            
            existing_data["reglas"] = existing_data["reglas"][-50:]
            existing_data["respuestas"] = existing_data["respuestas"][-30:]
            
            client.set(key, json.dumps(existing_data, ensure_ascii=False), ex=60*60*24*90)
            
            logger.info(f"Saved learning for business {business_id} to Redis")
            
        except Exception as e:
            logger.error(f"Error saving learning: {e}")
    
    def load_learning(self, business_id: str) -> Dict[str, Any]:
        """Load learning from Redis"""
        client = _get_redis_client()
        
        if client is None:
            return {"reglas": [], "respuestas": []}
        
        try:
            key = f"agent_v2:rules:{business_id}"
            data = client.get(key)
            if data:
                return json.loads(data)
        except Exception as e:
            logger.error(f"Error loading learning: {e}")
        
        return {"reglas": [], "respuestas": []}


_refiner_agent: Optional[RefinerAgent] = None

def get_refiner_agent() -> RefinerAgent:
    global _refiner_agent
    if _refiner_agent is None:
        _refiner_agent = RefinerAgent()
    return _refiner_agent

"""
FASE 5: REFINER AGENT - APRENDIZAJE CONTROLADO
================================================
Separa reglas: reglas_pendientes vs reglas_activas
REGLA: Ninguna regla nueva se aplica automáticamente.
Las reglas nuevas van a pendientes hasta ser aprobadas.
"""

from typing import Dict, Any, Optional, List
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage
import json
import logging
import redis

from ..config import get_settings, get_refiner_model
from ..schemas.vendor_state import (
    ObserverOutput, RefinerOutput, 
    ObserverValidation
)

logger = logging.getLogger(__name__)


REFINER_CONTROLLED_PROMPT = """Eres el "Refiner Agent" (Cerebro 3) de un sistema multi-agente de ventas.

## TU ROL:
Generar PROPUESTAS de nuevas reglas basadas en los insights del Observer.
IMPORTANTE: Las reglas que generes NO se aplican automáticamente.
Van a una cola de PENDIENTES para revisión humana.

## FORMATO DE RESPUESTA OBLIGATORIO:
```json
{
  "nuevas_reglas_pendientes": ["reglas propuestas para revisión"],
  "respuestas_sugeridas": [{"situacion": "...", "respuesta_sugerida": "..."}],
  "reglas_a_desactivar": ["reglas existentes que deberían desactivarse"],
  "justificacion": "por qué propones estos cambios"
}
```

## CRITERIOS PARA PROPONER REGLAS:
- La regla debe ser específica y accionable
- Debe basarse en patrones repetitivos, no en casos aislados
- No debe contradecir políticas del negocio
- Debe mejorar métricas (conversión, satisfacción)

## CRITERIOS PARA DESACTIVAR REGLAS:
- La regla está causando respuestas incorrectas
- La regla es demasiado genérica
- La regla contradice nuevas políticas

## IMPORTANTE:
- Solo propón reglas si hay evidencia clara de mejora
- Justifica cada propuesta
- Si no hay nada que proponer, devuelve listas vacías
"""


REFINER_LEGACY_PROMPT = """Eres el "Refiner Agent" (Cerebro 3) de un sistema multi-agente de ventas.

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
        self._current_model = get_refiner_model()
        self.llm = ChatOpenAI(
            api_key=self.settings.openai_api_key,
            model=self._current_model,
            temperature=0.3
        )
    
    def _ensure_model_current(self):
        """Check if model config changed and refresh if needed."""
        platform_model = get_refiner_model()
        if platform_model != self._current_model:
            logger.info(f"RefinerAgent model changed: {self._current_model} -> {platform_model}")
            self._current_model = platform_model
            self.llm = ChatOpenAI(
                api_key=self.settings.openai_api_key,
                model=platform_model,
                temperature=0.3
            )
    
    async def propose_rules(
        self,
        observer_validation: ObserverValidation,
        business_id: str,
        existing_active_rules: List[str],
        existing_pending_rules: List[str]
    ) -> tuple[RefinerOutput, int]:
        """
        FASE 5: Método principal del Refiner.
        Propone reglas que van a PENDIENTES, no se aplican automáticamente.
        """
        self._ensure_model_current()
        
        if not observer_validation.warnings and not observer_validation.errores:
            return RefinerOutput(), 0
        
        existing_rules_text = "\n".join([f"- [ACTIVA] {rule}" for rule in existing_active_rules[-15:]])
        pending_rules_text = "\n".join([f"- [PENDIENTE] {rule}" for rule in existing_pending_rules[-10:]])
        
        refine_prompt = f"""## RESULTADO DE VALIDACIÓN:
Errores: {json.dumps(observer_validation.errores, ensure_ascii=False)}
Warnings: {json.dumps(observer_validation.warnings, ensure_ascii=False)}
Validaciones pasadas: {json.dumps(observer_validation.validaciones_pasadas, ensure_ascii=False)}

## REGLAS ACTIVAS ACTUALES:
{existing_rules_text or "Ninguna"}

## REGLAS PENDIENTES (esperando aprobación):
{pending_rules_text or "Ninguna"}

Propón nuevas reglas SOLO si hay patrones claros de mejora.
Las reglas irán a PENDIENTES, no se aplican automáticamente.
"""
        
        messages = [
            SystemMessage(content=REFINER_CONTROLLED_PROMPT),
            HumanMessage(content=refine_prompt)
        ]
        
        try:
            response = self.llm.invoke(messages)
            
            tokens_used = 0
            if hasattr(response, "response_metadata"):
                usage = response.response_metadata.get("token_usage", {})
                tokens_used = usage.get("total_tokens", 0)
            
            output = self._parse_controlled_response(response.content)
            
            if output.nuevas_reglas_pendientes or output.reglas_a_desactivar:
                self._save_pending_rules(business_id, output)
            
            return output, tokens_used
            
        except Exception as e:
            logger.error(f"Refiner propose_rules error: {e}")
            return RefinerOutput(), 0
    
    def _parse_controlled_response(self, content: str) -> RefinerOutput:
        """Parse response into RefinerOutput with pending rules."""
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
                nuevas_reglas_pendientes=data.get("nuevas_reglas_pendientes", []),
                respuestas_sugeridas=data.get("respuestas_sugeridas", []),
                reglas_a_desactivar=data.get("reglas_a_desactivar", []),
                justificacion=data.get("justificacion")
            )
            
        except json.JSONDecodeError as e:
            logger.warning(f"Could not parse refiner controlled response: {e}")
            return RefinerOutput()
    
    def _save_pending_rules(self, business_id: str, output: RefinerOutput) -> None:
        """Save pending rules to Redis (separate from active rules)."""
        client = _get_redis_client()
        
        if client is None:
            logger.warning("Redis not available, pending rules not saved")
            return
        
        try:
            pending_key = f"agent_v2:rules_pending:{business_id}"
            
            existing_pending = []
            existing_raw = client.get(pending_key)
            if existing_raw:
                existing_pending = json.loads(existing_raw)
            
            for rule in output.nuevas_reglas_pendientes:
                if rule not in existing_pending:
                    existing_pending.append({
                        "regla": rule,
                        "justificacion": output.justificacion,
                        "estado": "pendiente"
                    })
            
            existing_pending = existing_pending[-30:]
            
            client.set(pending_key, json.dumps(existing_pending, ensure_ascii=False), ex=60*60*24*30)
            
            logger.info(f"Saved {len(output.nuevas_reglas_pendientes)} pending rules for business {business_id}")
            
        except Exception as e:
            logger.error(f"Error saving pending rules: {e}")
    
    def approve_rule(self, business_id: str, rule_index: int) -> bool:
        """Approve a pending rule and move it to active rules."""
        client = _get_redis_client()
        if client is None:
            return False
        
        try:
            pending_key = f"agent_v2:rules_pending:{business_id}"
            active_key = f"agent_v2:rules:{business_id}"
            
            pending_raw = client.get(pending_key)
            if not pending_raw:
                return False
            
            pending_rules = json.loads(pending_raw)
            if rule_index >= len(pending_rules):
                return False
            
            rule_to_approve = pending_rules.pop(rule_index)
            
            active_data = {"reglas": [], "respuestas": []}
            active_raw = client.get(active_key)
            if active_raw:
                active_data = json.loads(active_raw)
            
            active_data["reglas"].append(rule_to_approve["regla"])
            active_data["reglas"] = active_data["reglas"][-50:]
            
            client.set(pending_key, json.dumps(pending_rules, ensure_ascii=False), ex=60*60*24*30)
            client.set(active_key, json.dumps(active_data, ensure_ascii=False), ex=60*60*24*90)
            
            logger.info(f"Approved rule for business {business_id}: {rule_to_approve['regla'][:50]}...")
            return True
            
        except Exception as e:
            logger.error(f"Error approving rule: {e}")
            return False
    
    def reject_rule(self, business_id: str, rule_index: int) -> bool:
        """Reject and remove a pending rule."""
        client = _get_redis_client()
        if client is None:
            return False
        
        try:
            pending_key = f"agent_v2:rules_pending:{business_id}"
            
            pending_raw = client.get(pending_key)
            if not pending_raw:
                return False
            
            pending_rules = json.loads(pending_raw)
            if rule_index >= len(pending_rules):
                return False
            
            rejected_rule = pending_rules.pop(rule_index)
            
            client.set(pending_key, json.dumps(pending_rules, ensure_ascii=False), ex=60*60*24*30)
            
            logger.info(f"Rejected rule for business {business_id}: {rejected_rule['regla'][:50]}...")
            return True
            
        except Exception as e:
            logger.error(f"Error rejecting rule: {e}")
            return False
    
    def get_pending_rules(self, business_id: str) -> List[Dict[str, Any]]:
        """Get all pending rules for a business."""
        client = _get_redis_client()
        if client is None:
            return []
        
        try:
            pending_key = f"agent_v2:rules_pending:{business_id}"
            pending_raw = client.get(pending_key)
            if pending_raw:
                return json.loads(pending_raw)
        except Exception as e:
            logger.error(f"Error getting pending rules: {e}")
        
        return []
    
    async def refine(
        self,
        observer_output: ObserverOutput,
        business_id: str,
        existing_rules: List[str]
    ) -> tuple[RefinerOutput, int]:
        """Legacy method for backward compatibility."""
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
            SystemMessage(content=REFINER_LEGACY_PROMPT),
            HumanMessage(content=refine_prompt)
        ]
        
        try:
            response = self.llm.invoke(messages)
            
            tokens_used = 0
            if hasattr(response, "response_metadata"):
                usage = response.response_metadata.get("token_usage", {})
                tokens_used = usage.get("total_tokens", 0)
            
            output = self._parse_legacy_response(response.content)
            
            if output.nuevas_reglas_pendientes or output.respuestas_sugeridas:
                self._save_learning_legacy(business_id, output)
            
            return output, tokens_used
            
        except Exception as e:
            logger.error(f"Refiner agent error: {e}")
            return RefinerOutput(), 0
    
    def _parse_legacy_response(self, content: str) -> RefinerOutput:
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
            
            return RefinerOutput(
                nuevas_reglas_pendientes=data.get("nuevas_reglas", []),
                respuestas_sugeridas=data.get("nuevas_respuestas", [])
            )
            
        except json.JSONDecodeError as e:
            logger.warning(f"Could not parse refiner response: {e}")
            return RefinerOutput()
    
    def _save_learning_legacy(self, business_id: str, output: RefinerOutput) -> None:
        """Legacy save method - now saves to pending instead of active."""
        client = _get_redis_client()
        
        if client is None:
            logger.warning("Redis not available, learning not saved")
            return
        
        try:
            pending_key = f"agent_v2:rules_pending:{business_id}"
            
            existing_pending = []
            existing_raw = client.get(pending_key)
            if existing_raw:
                existing_pending = json.loads(existing_raw)
            
            for rule in output.nuevas_reglas_pendientes:
                if rule not in [r.get("regla") if isinstance(r, dict) else r for r in existing_pending]:
                    existing_pending.append({
                        "regla": rule,
                        "justificacion": "Generado automáticamente por sistema legacy",
                        "estado": "pendiente"
                    })
            
            existing_pending = existing_pending[-30:]
            
            client.set(pending_key, json.dumps(existing_pending, ensure_ascii=False), ex=60*60*24*30)
            
            logger.info(f"Saved learning as pending rules for business {business_id}")
            
        except Exception as e:
            logger.error(f"Error saving learning: {e}")
    
    def load_learning(self, business_id: str) -> Dict[str, Any]:
        """Load active learning from Redis."""
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

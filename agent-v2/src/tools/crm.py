from typing import Dict, Any
import httpx
import logging

from ..schemas.tool_schemas import CRMInput, CRMOutput
from ..config import get_settings
from ..core.memory import update_memory, set_stage, add_preference

logger = logging.getLogger(__name__)


class CRMTool:
    name = "crm"
    description = "Gestiona tags, etapas e intenciones del lead en el CRM"
    
    @staticmethod
    async def run(input_data: CRMInput) -> CRMOutput:
        settings = get_settings()
        
        try:
            if input_data.action == "set_tag":
                async with httpx.AsyncClient(timeout=30.0) as client:
                    response = await client.post(
                        f"{settings.core_api_url}/crm/tags/assign",
                        json={
                            "businessId": input_data.business_id,
                            "leadId": input_data.lead_id,
                            "tagName": input_data.tag_name
                        },
                        headers={
                            "Content-Type": "application/json",
                            "X-Internal-Secret": settings.internal_agent_secret
                        }
                    )
                    
                    if response.status_code in [200, 201]:
                        return CRMOutput(
                            success=True,
                            action_performed="set_tag",
                            message=f"Tag '{input_data.tag_name}' asignado correctamente"
                        )
            
            elif input_data.action == "update_stage":
                set_stage(input_data.lead_id, input_data.business_id, input_data.stage_name or "")
                
                async with httpx.AsyncClient(timeout=30.0) as client:
                    response = await client.post(
                        f"{settings.core_api_url}/crm/stages/update",
                        json={
                            "businessId": input_data.business_id,
                            "leadId": input_data.lead_id,
                            "stageName": input_data.stage_name
                        },
                        headers={
                            "Content-Type": "application/json",
                            "X-Internal-Secret": settings.internal_agent_secret
                        }
                    )
                
                return CRMOutput(
                    success=True,
                    action_performed="update_stage",
                    message=f"Etapa actualizada a '{input_data.stage_name}'"
                )
            
            elif input_data.action == "register_intent":
                add_preference(input_data.lead_id, input_data.business_id, input_data.intent or "")
                
                return CRMOutput(
                    success=True,
                    action_performed="register_intent",
                    message=f"Intención registrada: {input_data.intent}"
                )
            
            elif input_data.action == "add_note":
                update_memory(
                    input_data.lead_id, 
                    input_data.business_id, 
                    {"notes": [input_data.note]}
                )
                
                return CRMOutput(
                    success=True,
                    action_performed="add_note",
                    message="Nota agregada correctamente"
                )
            
            elif input_data.action == "update_data":
                if input_data.data:
                    update_memory(
                        input_data.lead_id,
                        input_data.business_id,
                        {"collected_data": input_data.data}
                    )
                    
                    return CRMOutput(
                        success=True,
                        action_performed="update_data",
                        message="Datos del lead actualizados",
                        updated_data=input_data.data
                    )
            
            return CRMOutput(
                success=False,
                message=f"Acción no reconocida: {input_data.action}"
            )
            
        except httpx.TimeoutException:
            if input_data.action in ["update_stage", "register_intent", "add_note"]:
                return CRMOutput(
                    success=True,
                    action_performed=input_data.action,
                    message=f"Acción '{input_data.action}' registrada localmente"
                )
            return CRMOutput(
                success=False,
                message="Timeout al conectar con Core API"
            )
        except Exception as e:
            logger.error(f"Error in CRM tool: {e}")
            return CRMOutput(
                success=False,
                message=f"Error en CRM: {str(e)}"
            )

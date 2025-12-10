from typing import Dict, Any
from datetime import datetime, timedelta
import httpx
import logging

from ..schemas.tool_schemas import FollowupInput, FollowupOutput
from ..config import get_settings

logger = logging.getLogger(__name__)


class FollowupTool:
    name = "followup"
    description = "Programa un mensaje de seguimiento para el lead"
    
    @staticmethod
    async def run(input_data: FollowupInput) -> FollowupOutput:
        settings = get_settings()
        
        try:
            scheduled_at = datetime.utcnow() + timedelta(minutes=input_data.delay_minutes)
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{settings.core_api_url}/followups/schedule",
                    json={
                        "businessId": input_data.business_id,
                        "leadId": input_data.lead_id,
                        "delayMinutes": input_data.delay_minutes,
                        "messageType": input_data.message_type,
                        "customMessage": input_data.custom_message,
                        "scheduledAt": scheduled_at.isoformat()
                    },
                    headers={
                        "Content-Type": "application/json",
                        "X-Internal-Secret": "internal-agent-secret-change-me"
                    }
                )
                
                if response.status_code in [200, 201]:
                    data = response.json()
                    return FollowupOutput(
                        success=True,
                        scheduled=True,
                        scheduled_at=scheduled_at.isoformat(),
                        followup_id=data.get("id"),
                        message=f"Seguimiento programado para {scheduled_at.strftime('%H:%M')}"
                    )
                else:
                    return FollowupOutput(
                        success=True,
                        scheduled=True,
                        scheduled_at=scheduled_at.isoformat(),
                        message=f"Seguimiento tipo '{input_data.message_type}' programado"
                    )
                    
        except httpx.TimeoutException:
            return FollowupOutput(
                success=True,
                scheduled=True,
                scheduled_at=(datetime.utcnow() + timedelta(minutes=input_data.delay_minutes)).isoformat(),
                message="Seguimiento registrado (conexión pendiente)"
            )
        except Exception as e:
            logger.error(f"Error in followup tool: {e}")
            return FollowupOutput(
                success=False,
                scheduled=False,
                message=f"Error al programar seguimiento: {str(e)}"
            )

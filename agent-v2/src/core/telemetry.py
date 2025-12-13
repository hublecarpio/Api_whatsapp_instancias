"""
Telemetry module for sending tool execution logs to Core API.
"""
import httpx
import logging
import asyncio
from typing import Dict, Any, Optional
from ..config import get_settings

logger = logging.getLogger(__name__)


async def log_tool_execution(
    business_id: str,
    tool_name: str,
    tool_input: Dict[str, Any],
    result: Optional[str],
    success: bool,
    error: Optional[str],
    duration_ms: int,
    contact_phone: Optional[str] = None
) -> bool:
    """
    Send tool execution log to Core API.
    Non-blocking - failures are logged but don't interrupt the main flow.
    """
    settings = get_settings()
    core_api_url = settings.core_api_url
    
    if not core_api_url:
        logger.warning("CORE_API_URL not set, skipping telemetry")
        return False
    
    try:
        endpoint = f"{core_api_url}/agent/tools/internal/log"
        
        payload = {
            "businessId": business_id,
            "toolName": tool_name,
            "contactPhone": contact_phone,
            "request": tool_input,
            "response": result[:1000] if result and len(result) > 1000 else result,
            "status": "success" if success else "error",
            "duration": duration_ms,
            "error": error
        }
        
        headers = {
            "Content-Type": "application/json"
        }
        
        internal_secret = settings.internal_agent_secret
        if internal_secret:
            headers["X-Internal-Secret"] = internal_secret
        
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(endpoint, json=payload, headers=headers)
            
            if response.status_code == 200:
                logger.debug(f"Tool execution logged: {tool_name}")
                return True
            else:
                logger.warning(f"Failed to log tool execution: {response.status_code} - {response.text}")
                return False
                
    except httpx.TimeoutException:
        logger.warning(f"Timeout logging tool execution for {tool_name}")
        return False
    except Exception as e:
        logger.warning(f"Error logging tool execution: {e}")
        return False


def log_tool_execution_fire_and_forget(
    business_id: str,
    tool_name: str,
    tool_input: Dict[str, Any],
    result: Optional[str],
    success: bool,
    error: Optional[str],
    duration_ms: int,
    contact_phone: Optional[str] = None
):
    """
    Fire and forget version - schedules the log without waiting.
    Use this to avoid blocking the response.
    """
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.create_task(
                log_tool_execution(
                    business_id=business_id,
                    tool_name=tool_name,
                    tool_input=tool_input,
                    result=result,
                    success=success,
                    error=error,
                    duration_ms=duration_ms,
                    contact_phone=contact_phone
                )
            )
        else:
            loop.run_until_complete(
                log_tool_execution(
                    business_id=business_id,
                    tool_name=tool_name,
                    tool_input=tool_input,
                    result=result,
                    success=success,
                    error=error,
                    duration_ms=duration_ms,
                    contact_phone=contact_phone
                )
            )
    except Exception as e:
        logger.warning(f"Failed to schedule tool execution log: {e}")

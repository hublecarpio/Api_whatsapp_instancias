"""
Custom Tool Handler - Ejecuta tools HTTP personalizadas definidas por el usuario.
Soporta interpolación de parámetros dinámicos en URL, headers y body.
"""

import httpx
import json
import re
import logging
from typing import Dict, Any, Optional
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class CustomToolInput(BaseModel):
    """Input genérico para tools personalizadas."""
    tool_name: str = Field(..., description="Nombre de la tool a ejecutar")
    parameters: Dict[str, Any] = Field(default_factory=dict, description="Parámetros para la tool")


class CustomToolOutput(BaseModel):
    """Output genérico de tools personalizadas."""
    success: bool
    message: str
    data: Optional[Dict[str, Any]] = None
    summary: Optional[str] = None
    error: Optional[str] = None


def summarize_array_response(data: Any, max_items: int = 5) -> str:
    """Sintetiza arrays grandes en texto útil para el LLM."""
    if isinstance(data, list):
        total = len(data)
        items = data[:max_items]
        
        summary_parts = []
        for i, item in enumerate(items, 1):
            if isinstance(item, dict):
                key_values = []
                for k, v in list(item.items())[:4]:
                    if v is not None and str(v).strip():
                        key_values.append(f"{k}: {v}")
                summary_parts.append(f"{i}. {', '.join(key_values)}")
            else:
                summary_parts.append(f"{i}. {item}")
        
        result = "\n".join(summary_parts)
        if total > max_items:
            result += f"\n... y {total - max_items} más (total: {total})"
        return result
    
    elif isinstance(data, dict):
        if 'data' in data and isinstance(data['data'], list):
            return summarize_array_response(data['data'], max_items)
        if 'results' in data and isinstance(data['results'], list):
            return summarize_array_response(data['results'], max_items)
        if 'items' in data and isinstance(data['items'], list):
            return summarize_array_response(data['items'], max_items)
        
        key_values = []
        for k, v in list(data.items())[:6]:
            if v is not None and not isinstance(v, (list, dict)):
                key_values.append(f"{k}: {v}")
        return ", ".join(key_values)
    
    return str(data)[:500]


def interpolate_params(template: Any, params: Dict[str, Any]) -> Any:
    """Interpola {{paramName}} en strings, dicts, y listas."""
    if isinstance(template, str):
        def replace_match(match):
            key = match.group(1)
            value = params.get(key, match.group(0))
            return str(value) if value is not None else match.group(0)
        return re.sub(r'\{\{(\w+)\}\}', replace_match, template)
    elif isinstance(template, dict):
        return {k: interpolate_params(v, params) for k, v in template.items()}
    elif isinstance(template, list):
        return [interpolate_params(item, params) for item in template]
    return template


class CustomToolHandler:
    """Ejecutor de tools HTTP personalizadas."""
    
    @staticmethod
    async def run(
        tool_config: Dict[str, Any],
        parameters: Dict[str, Any]
    ) -> CustomToolOutput:
        """
        Ejecuta una tool personalizada.
        
        Args:
            tool_config: Configuración de la tool (url, method, headers, bodyTemplate)
            parameters: Parámetros proporcionados por el agente
            
        Returns:
            CustomToolOutput con el resultado
        """
        try:
            url = tool_config.get("url", "")
            method = tool_config.get("method", "POST").upper()
            headers_template = tool_config.get("headers") or {}
            body_template = tool_config.get("bodyTemplate") or {}
            
            url = interpolate_params(url, parameters)
            headers = interpolate_params(headers_template, parameters)
            
            if not isinstance(headers, dict):
                headers = {}
            
            if "Content-Type" not in headers:
                headers["Content-Type"] = "application/json"
            
            body = None
            if method in ["POST", "PUT", "PATCH"] and body_template:
                body = interpolate_params(body_template, parameters)
            
            logger.info(f"Executing custom tool: {method} {url}")
            logger.debug(f"Parameters: {parameters}")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                if method == "GET":
                    response = await client.get(url, headers=headers, params=parameters)
                elif method == "POST":
                    response = await client.post(url, headers=headers, json=body)
                elif method == "PUT":
                    response = await client.put(url, headers=headers, json=body)
                elif method == "PATCH":
                    response = await client.patch(url, headers=headers, json=body)
                elif method == "DELETE":
                    response = await client.delete(url, headers=headers)
                else:
                    return CustomToolOutput(
                        success=False,
                        message=f"Método HTTP no soportado: {method}",
                        error=f"Unsupported method: {method}"
                    )
                
                response_data = None
                try:
                    response_data = response.json()
                except:
                    response_data = {"text": response.text[:1000]}
                
                if response.is_success:
                    summary = summarize_array_response(response_data)
                    return CustomToolOutput(
                        success=True,
                        message=f"Tool ejecutada exitosamente",
                        data=response_data,
                        summary=summary
                    )
                else:
                    return CustomToolOutput(
                        success=False,
                        message=f"Error HTTP {response.status_code}",
                        data=response_data,
                        error=f"HTTP {response.status_code}"
                    )
                    
        except httpx.TimeoutException:
            logger.error(f"Timeout executing custom tool")
            return CustomToolOutput(
                success=False,
                message="Timeout: La tool tardó demasiado en responder",
                error="Timeout"
            )
        except Exception as e:
            logger.error(f"Error executing custom tool: {e}")
            return CustomToolOutput(
                success=False,
                message=f"Error al ejecutar tool: {str(e)}",
                error=str(e)
            )

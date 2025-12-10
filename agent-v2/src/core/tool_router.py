from typing import Dict, Any, Optional, List
import logging
import json

from ..schemas.tool_schemas import (
    SearchProductInput, SearchProductOutput,
    PaymentInput, PaymentOutput,
    FollowupInput, FollowupOutput,
    MediaInput, MediaOutput,
    CRMInput, CRMOutput
)
from ..tools.search_product import SearchProductTool
from ..tools.payment import PaymentTool
from ..tools.followup import FollowupTool
from ..tools.media import MediaTool
from ..tools.crm import CRMTool

logger = logging.getLogger(__name__)


TOOL_DEFINITIONS = {
    "search_product": {
        "name": "search_product",
        "description": "Busca productos en el catálogo usando búsqueda semántica. Úsalo cuando el cliente pregunte por un producto específico.",
        "input_schema": SearchProductInput,
        "output_schema": SearchProductOutput,
        "handler": SearchProductTool
    },
    "payment": {
        "name": "payment", 
        "description": "Genera un link de pago para un producto. Úsalo cuando el cliente quiera comprar algo.",
        "input_schema": PaymentInput,
        "output_schema": PaymentOutput,
        "handler": PaymentTool
    },
    "followup": {
        "name": "followup",
        "description": "Programa un mensaje de seguimiento. Úsalo cuando el cliente no responde o para recordatorios.",
        "input_schema": FollowupInput,
        "output_schema": FollowupOutput,
        "handler": FollowupTool
    },
    "media": {
        "name": "media",
        "description": "Obtiene URLs de imágenes o documentos. Úsalo cuando necesites enviar una imagen de producto.",
        "input_schema": MediaInput,
        "output_schema": MediaOutput,
        "handler": MediaTool
    },
    "crm": {
        "name": "crm",
        "description": "Gestiona el CRM: asigna tags, actualiza etapas, registra intenciones. Úsalo para tracking del lead.",
        "input_schema": CRMInput,
        "output_schema": CRMOutput,
        "handler": CRMTool
    }
}


class ToolRouter:
    def __init__(self, context: Optional[Dict[str, Any]] = None):
        self.context = context or {}
        self.embedded_products = context.get("embedded_products", []) if context else []
        self.products = context.get("products", []) if context else []
        self.business_id = context.get("business_id", "") if context else ""
        self.lead_id = context.get("lead_id", "") if context else ""
    
    def get_available_tools(self) -> List[Dict[str, str]]:
        return [
            {
                "name": tool["name"],
                "description": tool["description"]
            }
            for tool in TOOL_DEFINITIONS.values()
        ]
    
    def get_tools_for_prompt(self) -> str:
        tools_text = "## Herramientas disponibles:\n\n"
        for tool in TOOL_DEFINITIONS.values():
            tools_text += f"- **{tool['name']}**: {tool['description']}\n"
        return tools_text
    
    async def execute_tool(
        self, 
        tool_name: str, 
        input_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        if tool_name not in TOOL_DEFINITIONS:
            return {
                "success": False,
                "error": f"Tool '{tool_name}' not found",
                "message": f"Herramienta no disponible: {tool_name}"
            }
        
        tool_def = TOOL_DEFINITIONS[tool_name]
        input_schema = tool_def["input_schema"]
        handler = tool_def["handler"]
        
        try:
            if tool_name in ["payment", "followup", "crm"]:
                input_data["business_id"] = input_data.get("business_id") or self.business_id
                input_data["lead_id"] = input_data.get("lead_id") or self.lead_id
            
            validated_input = input_schema(**input_data)
            
            if tool_name == "search_product":
                result = await handler.run(validated_input, self.embedded_products)
            elif tool_name == "media":
                result = await handler.run(validated_input, self.products)
            else:
                result = await handler.run(validated_input)
            
            return result.model_dump()
            
        except Exception as e:
            logger.error(f"Error executing tool {tool_name}: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": f"Error al ejecutar {tool_name}: {str(e)}"
            }
    
    def validate_tool_call(self, tool_name: str, input_data: Dict[str, Any]) -> tuple[bool, Optional[str]]:
        if tool_name not in TOOL_DEFINITIONS:
            return False, f"Tool '{tool_name}' no existe"
        
        tool_def = TOOL_DEFINITIONS[tool_name]
        input_schema = tool_def["input_schema"]
        
        try:
            input_schema(**input_data)
            return True, None
        except Exception as e:
            return False, str(e)


def format_tool_result(result: Dict[str, Any]) -> str:
    if result.get("success"):
        message = result.get("message", "Operación exitosa")
        
        if "products" in result and result["products"]:
            products = result["products"][:3]
            products_text = "\n".join([
                f"- {p.get('name', 'Producto')}: {p.get('currency', '$')}{p.get('price', 'N/A')}"
                for p in products
            ])
            return f"{message}\n\nProductos encontrados:\n{products_text}"
        
        if "payment_url" in result and result["payment_url"]:
            return f"{message}\n\nLink de pago: {result['payment_url']}"
        
        if "media_url" in result and result["media_url"]:
            return f"{message}\n\nURL: {result['media_url']}"
        
        return message
    else:
        return result.get("message", result.get("error", "Error desconocido"))

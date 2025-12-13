from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any


TOOL_OUTPUT_SCHEMAS: Dict[str, Dict[str, type]] = {
    "search_product": {
        "products": list,
        "message": str
    },
    "payment": {
        "payment_url": str,
        "message": str
    },
    "followup": {
        "scheduled": bool,
        "message": str
    },
    "media": {
        "sent": bool,
        "media_url": str,
        "message": str
    },
    "crm": {
        "status": str,
        "message": str
    },
    "search_knowledge": {
        "context": str,
        "message": str
    },
    "custom_tool": {
        "result": str,
        "message": str
    }
}


BLOCKED_FIELDS = {
    "id", "ids", "_id", "internal_id", "business_id", "lead_id", "user_id",
    "token", "tokens", "api_key", "secret", "password", "auth",
    "metadata", "_metadata", "internal", "_internal",
    "stack", "stacktrace", "traceback", "error_details",
    "raw", "raw_response", "debug", "_debug",
    "database_id", "db_id", "record_id"
}


def sanitize_tool_output(tool_name: str, raw_output: Dict[str, Any]) -> Dict[str, Any]:
    """
    Filtra el output de una tool para que el LLM solo vea campos permitidos.
    Los campos no listados se ignoran para el LLM pero se conservan para logs.
    """
    base_tool_name = tool_name.replace("custom_", "") if tool_name.startswith("custom_") else tool_name
    
    if tool_name.startswith("custom_"):
        schema = TOOL_OUTPUT_SCHEMAS.get("custom_tool", {})
    else:
        schema = TOOL_OUTPUT_SCHEMAS.get(base_tool_name, {})
    
    if not schema:
        return {
            "success": raw_output.get("success", False),
            "message": raw_output.get("message", "Operación completada")
        }
    
    sanitized = {}
    
    sanitized["success"] = raw_output.get("success", False)
    
    for field_name in schema.keys():
        if field_name in raw_output and raw_output[field_name] is not None:
            value = raw_output[field_name]
            
            if isinstance(value, list):
                sanitized[field_name] = _sanitize_list(value)
            elif isinstance(value, dict):
                sanitized[field_name] = _sanitize_dict(value)
            else:
                sanitized[field_name] = value
    
    if "message" not in sanitized:
        if raw_output.get("success"):
            sanitized["message"] = "Operación exitosa"
        else:
            error = raw_output.get("error", "Error desconocido")
            if not _contains_blocked_info(str(error)):
                sanitized["message"] = f"Error: {error}"
            else:
                sanitized["message"] = "Ocurrió un error al procesar la solicitud"
    
    return sanitized


def _sanitize_dict(data: Dict[str, Any]) -> Dict[str, Any]:
    """Elimina campos bloqueados de un diccionario."""
    result = {}
    for key, value in data.items():
        if key.lower() in BLOCKED_FIELDS:
            continue
        if key.startswith("_"):
            continue
        if isinstance(value, dict):
            result[key] = _sanitize_dict(value)
        elif isinstance(value, list):
            result[key] = _sanitize_list(value)
        else:
            if not _contains_blocked_info(str(value)):
                result[key] = value
    return result


def _sanitize_list(data: List[Any]) -> List[Any]:
    """Sanitiza una lista de elementos."""
    result = []
    for item in data:
        if isinstance(item, dict):
            result.append(_sanitize_dict(item))
        elif isinstance(item, list):
            result.append(_sanitize_list(item))
        else:
            result.append(item)
    return result


def _contains_blocked_info(text: str) -> bool:
    """Detecta si un texto contiene información técnica bloqueada."""
    blocked_patterns = [
        "traceback", "stacktrace", "at line",
        "internal server error", "database error",
        "api_key=", "token=", "secret=",
        "password=", "auth=",
        "record_id=", "document_id="
    ]
    text_lower = text.lower()
    return any(pattern in text_lower for pattern in blocked_patterns)


def format_products_for_llm(products: List[Dict[str, Any]], max_items: int = 5) -> List[Dict[str, Any]]:
    """Formatea lista de productos para consumo del LLM - solo info comercial."""
    formatted = []
    for product in products[:max_items]:
        formatted.append({
            "name": product.get("name", "Producto"),
            "price": product.get("price"),
            "currency": product.get("currency", "$"),
            "description": product.get("description", "")[:200] if product.get("description") else "",
            "available": product.get("available", True)
        })
    return formatted


class SearchProductInput(BaseModel):
    query: str = Field(..., description="Búsqueda del usuario para encontrar productos")
    max_results: int = Field(default=5, description="Máximo de resultados a retornar")


class SearchProductOutput(BaseModel):
    success: bool
    products: List[Dict[str, Any]] = Field(default_factory=list)
    best_match: Optional[Dict[str, Any]] = None
    similarity_score: Optional[float] = None
    message: Optional[str] = None


class PaymentInput(BaseModel):
    product_id: str = Field(..., description="ID del producto para generar link de pago")
    quantity: int = Field(default=1, description="Cantidad de productos")
    lead_id: str = Field(..., description="ID del lead/contacto")
    business_id: str = Field(..., description="ID del negocio")


class PaymentOutput(BaseModel):
    success: bool
    payment_url: Optional[str] = None
    short_code: Optional[str] = None
    message: Optional[str] = None
    error: Optional[str] = None


class FollowupInput(BaseModel):
    lead_id: str = Field(..., description="ID del lead para programar seguimiento")
    business_id: str = Field(..., description="ID del negocio")
    delay_minutes: int = Field(default=60, description="Minutos de espera antes del followup")
    message_type: str = Field(default="reminder", description="Tipo de mensaje: reminder, offer, check_in")
    custom_message: Optional[str] = Field(None, description="Mensaje personalizado opcional")


class FollowupOutput(BaseModel):
    success: bool
    scheduled: bool = False
    scheduled_at: Optional[str] = None
    followup_id: Optional[str] = None
    message: Optional[str] = None


class MediaInput(BaseModel):
    media_type: str = Field(..., description="Tipo: image, pdf, video, catalog")
    product_id: Optional[str] = Field(None, description="ID del producto para obtener su imagen")
    resource_name: Optional[str] = Field(None, description="Nombre del recurso específico")


class MediaOutput(BaseModel):
    success: bool
    media_url: Optional[str] = None
    media_type: Optional[str] = None
    file_name: Optional[str] = None
    message: Optional[str] = None


class CRMInput(BaseModel):
    action: str = Field(..., description="Acción: set_tag, update_stage, register_intent, add_note")
    lead_id: str = Field(..., description="ID del lead")
    business_id: str = Field(..., description="ID del negocio")
    tag_name: Optional[str] = Field(None, description="Nombre del tag a asignar")
    stage_name: Optional[str] = Field(None, description="Nombre de la etapa")
    intent: Optional[str] = Field(None, description="Intención detectada")
    note: Optional[str] = Field(None, description="Nota a agregar")
    data: Optional[Dict[str, Any]] = Field(None, description="Datos adicionales")


class CRMOutput(BaseModel):
    success: bool
    action_performed: Optional[str] = None
    message: Optional[str] = None
    updated_data: Optional[Dict[str, Any]] = None


class SearchKnowledgeInput(BaseModel):
    query: str = Field(..., description="Pregunta o tema a buscar en la base de conocimiento")
    max_results: int = Field(default=3, description="Máximo de documentos a retornar")


class SearchKnowledgeOutput(BaseModel):
    success: bool
    results: List[Dict[str, Any]] = Field(default_factory=list)
    context: Optional[str] = None
    message: Optional[str] = None

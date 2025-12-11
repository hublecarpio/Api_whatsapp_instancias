from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any


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

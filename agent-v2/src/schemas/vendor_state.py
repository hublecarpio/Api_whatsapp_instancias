from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any, Literal, Annotated, Sequence
from enum import Enum
from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages


class ActionType(str, Enum):
    RESPONSE = "respuesta"
    TOOL = "tool"


class EtapaComercial(str, Enum):
    """Etapas comerciales del proceso de venta."""
    NUEVO = "nuevo"
    EXPLORANDO = "explorando"
    INTERESADO = "interesado"
    COTIZANDO = "cotizando"
    NEGOCIANDO = "negociando"
    CONFIRMANDO = "confirmando"
    PAGANDO = "pagando"
    COMPLETADO = "completado"
    ABANDONADO = "abandonado"


class IntencionCliente(str, Enum):
    """Intenciones detectadas del cliente."""
    SALUDO = "saludo"
    CONSULTA_PRODUCTO = "consulta_producto"
    CONSULTA_PRECIO = "consulta_precio"
    CONSULTA_DISPONIBILIDAD = "consulta_disponibilidad"
    INTENCION_COMPRA = "intencion_compra"
    CONFIRMACION_COMPRA = "confirmacion_compra"
    OBJECION = "objecion"
    QUEJA = "queja"
    SOPORTE = "soporte"
    DESPEDIDA = "despedida"
    OTRO = "otro"


class ProductoDetectado(BaseModel):
    """Producto detectado en la conversación."""
    product_id: str
    nombre: str
    cantidad: int = 1
    precio_unitario: Optional[float] = None
    confirmado: bool = False


class EstadoError(BaseModel):
    """Error de estado que impide avanzar."""
    codigo: str
    mensaje: str
    campo_afectado: Optional[str] = None
    recoverable: bool = True


class CommercialState(BaseModel):
    """
    Estado Comercial Explícito - LEY SUPREMA
    REGLA: Si un dato no está en este estado, el agente NO puede actuar sobre él.
    """
    etapa_comercial: EtapaComercial = EtapaComercial.NUEVO
    intencion_actual: Optional[IntencionCliente] = None
    
    productos_detectados: List[ProductoDetectado] = Field(default_factory=list)
    productos_confirmados: List[ProductoDetectado] = Field(default_factory=list)
    cantidades: Dict[str, int] = Field(default_factory=dict)
    
    total_calculado: Optional[float] = None
    metodo_pago: Optional[str] = None
    orden_generada: Optional[str] = None
    payment_link: Optional[str] = None
    
    reglas_activas: List[str] = Field(default_factory=list)
    reglas_pendientes: List[str] = Field(default_factory=list)
    
    errores_estado: List[EstadoError] = Field(default_factory=list)
    warnings_estado: List[str] = Field(default_factory=list)
    
    estado_valido: bool = True
    puede_avanzar: bool = True
    
    ultima_actualizacion: Optional[str] = None

    def has_critical_errors(self) -> bool:
        """Verifica si hay errores críticos que impiden avanzar."""
        return any(not e.recoverable for e in self.errores_estado)
    
    def can_execute_tool(self, tool_name: str) -> tuple[bool, Optional[str]]:
        """Valida si se puede ejecutar una herramienta basado en el estado."""
        if not self.estado_valido:
            return False, "Estado inválido - no se pueden ejecutar herramientas"
        
        if tool_name == "payment":
            if not self.productos_confirmados:
                return False, "No hay productos confirmados para generar pago"
            if self.total_calculado is None or self.total_calculado <= 0:
                return False, "Total no calculado o inválido"
        
        return True, None
    
    def get_next_valid_actions(self) -> List[str]:
        """Retorna las acciones válidas según el estado actual."""
        actions = ["respuesta"]
        
        if self.etapa_comercial == EtapaComercial.NUEVO:
            actions.extend(["search_product", "search_knowledge"])
        elif self.etapa_comercial == EtapaComercial.EXPLORANDO:
            actions.extend(["search_product", "search_knowledge", "media"])
        elif self.etapa_comercial == EtapaComercial.INTERESADO:
            actions.extend(["search_product", "media", "crm"])
        elif self.etapa_comercial == EtapaComercial.COTIZANDO:
            if self.productos_detectados:
                actions.append("media")
        elif self.etapa_comercial == EtapaComercial.CONFIRMANDO:
            if self.productos_confirmados and self.total_calculado:
                actions.append("payment")
        elif self.etapa_comercial == EtapaComercial.PAGANDO:
            actions.append("followup")
        
        return actions


class VendorOutput(BaseModel):
    """
    Salida restringida del Vendor Agent.
    REGLA: El Vendor SOLO retorna esto. No ejecuta tools, no avanza etapas.
    """
    intencion: IntencionCliente
    mensaje: str
    entidades_detectadas: Dict[str, Any] = Field(default_factory=dict)
    productos_mencionados: List[str] = Field(default_factory=list)
    requiere_tool: bool = False
    tool_sugerida: Optional[str] = None
    tool_params_sugeridos: Optional[Dict[str, Any]] = None
    confianza: float = Field(default=0.8, ge=0.0, le=1.0)


class ObserverValidation(BaseModel):
    """
    Salida del Observer como VALIDADOR ESTRICTO.
    REGLA: Si estado_valido=false, el grafo NO avanza.
    """
    estado_valido: bool
    errores: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    validaciones_pasadas: List[str] = Field(default_factory=list)
    sugerencia_correccion: Optional[str] = None


class RefinerOutput(BaseModel):
    """
    Salida del Refiner con control de aprendizaje.
    REGLA: Las reglas nuevas van a pendientes, no se aplican automáticamente.
    """
    nuevas_reglas_pendientes: List[str] = Field(default_factory=list)
    respuestas_sugeridas: List[Dict[str, str]] = Field(default_factory=list)
    reglas_a_desactivar: List[str] = Field(default_factory=list)
    justificacion: Optional[str] = None


class AgentAction(BaseModel):
    """Acción legacy para compatibilidad."""
    accion: ActionType
    mensaje: Optional[str] = None
    nombre_tool: Optional[str] = None
    input_tool: Optional[Dict[str, Any]] = None


class ToolCallRequest(BaseModel):
    tool_name: str
    input_data: Dict[str, Any]


class LeadMemory(BaseModel):
    lead_id: str
    current_stage: Optional[str] = None
    collected_data: Dict[str, Any] = Field(default_factory=dict)
    products_viewed: List[str] = Field(default_factory=list)
    followups_sent: List[Dict[str, Any]] = Field(default_factory=list)
    detected_preferences: List[str] = Field(default_factory=list)
    objections: List[str] = Field(default_factory=list)
    last_interaction: Optional[str] = None


class ObserverOutput(BaseModel):
    """Legacy observer output for compatibility."""
    fallas: List[str] = Field(default_factory=list)
    objeciones: List[str] = Field(default_factory=list)
    recomendaciones: List[str] = Field(default_factory=list)


class VendorState(BaseModel):
    messages: Annotated[Sequence[BaseMessage], add_messages] = Field(default_factory=list)
    business_profile: Optional[Dict[str, Any]] = None
    lead_memory: Optional[Dict[str, Any]] = None
    current_message: str = ""
    sender_phone: str = ""
    sender_name: Optional[str] = None
    current_time: str = ""
    embedded_products: Optional[List[Dict[str, Any]]] = None
    dynamic_rules: List[str] = Field(default_factory=list)
    vendor_action: Optional[Dict[str, Any]] = None
    tool_result: Optional[str] = None
    final_response: Optional[str] = None
    observer_output: Optional[Dict[str, Any]] = None
    refiner_output: Optional[Dict[str, Any]] = None
    tokens_used: int = 0
    iteration_count: int = 0
    max_iterations: int = 5
    
    commercial_state: Optional[CommercialState] = None
    vendor_output: Optional[VendorOutput] = None
    observer_validation: Optional[ObserverValidation] = None

    class Config:
        arbitrary_types_allowed = True

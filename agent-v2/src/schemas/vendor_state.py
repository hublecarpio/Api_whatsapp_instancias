from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any, Literal, Annotated, Sequence
from enum import Enum
from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages


class ActionType(str, Enum):
    RESPONSE = "respuesta"
    TOOL = "tool"


class AgentAction(BaseModel):
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
    fallas: List[str] = Field(default_factory=list)
    objeciones: List[str] = Field(default_factory=list)
    recomendaciones: List[str] = Field(default_factory=list)


class RefinerOutput(BaseModel):
    nuevas_reglas: List[str] = Field(default_factory=list)
    nuevas_respuestas: List[Dict[str, str]] = Field(default_factory=list)


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

    class Config:
        arbitrary_types_allowed = True

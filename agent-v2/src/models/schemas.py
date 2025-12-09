from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from enum import Enum


class MessageRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"


class Message(BaseModel):
    role: MessageRole
    content: str


class Product(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    price: Optional[float] = None
    currency: str = "USD"
    category: Optional[str] = None
    stock: Optional[int] = None
    attributes: Dict[str, Any] = Field(default_factory=dict)


class BusinessContext(BaseModel):
    business_id: str
    business_name: str
    timezone: str = "America/Lima"
    products: List[Product] = Field(default_factory=list)
    policies: List[str] = Field(default_factory=list)
    custom_prompt: Optional[str] = None
    tools_enabled: bool = False
    tools_config: List[Dict[str, Any]] = Field(default_factory=list)


class GenerateRequest(BaseModel):
    business_context: BusinessContext
    conversation_history: List[Message] = Field(default_factory=list)
    current_message: str
    sender_phone: str
    sender_name: Optional[str] = None
    

class ToolCall(BaseModel):
    tool_name: str
    parameters: Dict[str, Any]
    result: Optional[str] = None


class GenerateResponse(BaseModel):
    success: bool
    response: Optional[str] = None
    tool_calls: List[ToolCall] = Field(default_factory=list)
    tokens_used: int = 0
    model: str = ""
    error: Optional[str] = None
    

class HealthResponse(BaseModel):
    status: str
    version: str = "2.0.0"
    model: str

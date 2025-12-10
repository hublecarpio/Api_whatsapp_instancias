from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field
import logging

from .config import get_settings
from .schemas.business_profile import BusinessProfile, Product
from .core.memory import get_memory, update_memory
from .core.embeddings import get_embedding_service
from .core.graph import get_agent_graph
from .agents.refiner import get_refiner_agent

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class MessageRole:
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"


class Message(BaseModel):
    role: str
    content: str


class ProductInput(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    price: Optional[float] = None
    currency: str = "USD"
    category: Optional[str] = None
    stock: Optional[int] = None
    image_url: Optional[str] = None
    attributes: Dict[str, Any] = Field(default_factory=dict)


class BusinessContextInput(BaseModel):
    business_id: str
    business_name: str
    timezone: str = "America/Lima"
    products: List[ProductInput] = Field(default_factory=list)
    policies: List[str] = Field(default_factory=list)
    custom_prompt: Optional[str] = None
    tools_enabled: bool = True
    tools_config: List[Dict[str, Any]] = Field(default_factory=list)


class GenerateRequest(BaseModel):
    business_context: BusinessContextInput
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
    type: str = "message"
    response: Optional[str] = None
    tool: Optional[str] = None
    tool_input: Optional[Dict[str, Any]] = None
    tool_calls: List[ToolCall] = Field(default_factory=list)
    tokens_used: int = 0
    model: str = ""
    error: Optional[str] = None
    observer_insights: Optional[Dict[str, Any]] = None
    new_rules_learned: int = 0


class HealthResponse(BaseModel):
    status: str
    version: str = "2.0.0"
    model: str
    features: List[str] = Field(default_factory=list)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    logger.info(f"Agent V2 Advanced starting on port {settings.port}")
    logger.info(f"Using model: {settings.openai_model}")
    
    if settings.openai_api_key:
        get_agent_graph()
        logger.info("Multi-agent graph initialized")
        logger.info("Features: Memory, Embeddings, Tools, Observer, Refiner")
    else:
        logger.warning("OPENAI_API_KEY not set - agent will not work")
    
    yield
    
    logger.info("Agent V2 Advanced shutting down")


app = FastAPI(
    title="EfficoreChat Agent V2 Advanced",
    description="Multi-Agent AI System with LangGraph, Tools, Memory, and Dynamic Learning",
    version="2.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse)
async def health_check():
    settings = get_settings()
    return HealthResponse(
        status="healthy",
        version="2.0.0",
        model=settings.openai_model,
        features=[
            "multi-agent",
            "langgraph",
            "memory",
            "embeddings",
            "tools",
            "observer",
            "refiner",
            "dynamic-learning"
        ]
    )


@app.post("/generate", response_model=GenerateResponse)
async def generate_response(request: GenerateRequest):
    settings = get_settings()
    
    if not settings.openai_api_key:
        raise HTTPException(
            status_code=500, 
            detail="OpenAI API key not configured"
        )
    
    try:
        business_id = request.business_context.business_id
        lead_id = request.sender_phone
        
        lead_memory = get_memory(lead_id, business_id)
        
        refiner = get_refiner_agent()
        learning_data = refiner.load_learning(business_id)
        dynamic_rules = learning_data.get("reglas", [])
        
        products = [
            Product(
                id=p.id,
                name=p.name,
                description=p.description,
                price=p.price,
                currency=p.currency,
                category=p.category,
                stock=p.stock,
                image_url=p.image_url,
                attributes=p.attributes
            )
            for p in request.business_context.products
        ]
        
        embedded_products = []
        if products:
            embedding_service = get_embedding_service()
            try:
                embedded_products = embedding_service.embed_products(products)
                logger.info(f"Embedded {len(embedded_products)} products")
            except Exception as e:
                logger.warning(f"Could not embed products: {e}")
                embedded_products = [{"product": p.model_dump(), "embedding": None} for p in products]
        
        conversation_history = [
            {"role": msg.role, "content": msg.content}
            for msg in request.conversation_history
        ]
        
        initial_state = {
            "messages": [],
            "business_profile": {
                "business_id": business_id,
                "business_name": request.business_context.business_name,
                "timezone": request.business_context.timezone,
                "products": [p.model_dump() for p in products],
                "policies": request.business_context.policies,
                "custom_prompt": request.business_context.custom_prompt,
                "tools_enabled": request.business_context.tools_enabled,
                "tools_config": request.business_context.tools_config
            },
            "lead_memory": lead_memory,
            "current_message": request.current_message,
            "sender_phone": request.sender_phone,
            "sender_name": request.sender_name,
            "embedded_products": embedded_products,
            "dynamic_rules": dynamic_rules,
            "conversation_history": conversation_history,
            "vendor_action": None,
            "tool_result": None,
            "final_response": None,
            "observer_output": None,
            "refiner_output": None,
            "tokens_used": 0,
            "iteration_count": 0,
            "max_iterations": 5
        }
        
        graph = get_agent_graph()
        result = await graph.ainvoke(initial_state)
        
        update_memory(lead_id, business_id, {
            "last_message": request.current_message
        })
        
        final_response = result.get("final_response", "")
        tokens_used = result.get("tokens_used", 0)
        observer_output = result.get("observer_output")
        refiner_output = result.get("refiner_output")
        vendor_action = result.get("vendor_action", {})
        
        new_rules_count = 0
        if refiner_output:
            new_rules_count = len(refiner_output.get("nuevas_reglas", []))
        
        response_type = "message"
        tool_name = None
        tool_input = None
        
        if vendor_action.get("accion") == "tool":
            response_type = "tool_call"
            tool_name = vendor_action.get("nombre_tool")
            tool_input = vendor_action.get("input_tool")
        
        return GenerateResponse(
            success=True,
            type=response_type,
            response=final_response,
            tool=tool_name,
            tool_input=tool_input,
            tokens_used=tokens_used,
            model=settings.openai_model,
            observer_insights=observer_output,
            new_rules_learned=new_rules_count
        )
        
    except Exception as e:
        logger.error(f"Error generating response: {e}", exc_info=True)
        return GenerateResponse(
            success=False,
            type="message",
            error=str(e)
        )


@app.get("/")
async def root():
    return {
        "service": "EfficoreChat Agent V2 Advanced",
        "version": "2.0.0",
        "status": "running",
        "architecture": "Multi-Agent (Vendor → Tools → Observer → Refiner)",
        "endpoints": {
            "health": "/health",
            "generate": "/generate (POST)"
        },
        "features": [
            "LangGraph State Machine",
            "Persistent Memory (Redis)",
            "Semantic Product Search (Embeddings)",
            "5 Tools (search, payment, followup, media, crm)",
            "Observer Agent (error detection)",
            "Refiner Agent (dynamic learning)"
        ]
    }


if __name__ == "__main__":
    import uvicorn
    settings = get_settings()
    uvicorn.run(app, host="0.0.0.0", port=settings.port)

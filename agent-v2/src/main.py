from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import logging

from .config import get_settings
from .models.schemas import (
    GenerateRequest, 
    GenerateResponse, 
    HealthResponse,
    BusinessContext,
    Product,
    Message
)
from .agents.sales_agent import get_sales_agent

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    logger.info(f"Agent V2 starting on port {settings.port}")
    logger.info(f"Using model: {settings.openai_model}")
    
    if settings.openai_api_key:
        get_sales_agent()
        logger.info("Sales agent initialized")
    else:
        logger.warning("OPENAI_API_KEY not set - agent will not work")
    
    yield
    
    logger.info("Agent V2 shutting down")


app = FastAPI(
    title="EfficoreChat Agent V2",
    description="Advanced AI Agent powered by LangGraph and Pydantic",
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
    """Health check endpoint."""
    settings = get_settings()
    return HealthResponse(
        status="healthy",
        version="2.0.0",
        model=settings.openai_model
    )


@app.post("/generate", response_model=GenerateResponse)
async def generate_response(request: GenerateRequest):
    """Generate AI response for a conversation."""
    settings = get_settings()
    
    if not settings.openai_api_key:
        raise HTTPException(
            status_code=500, 
            detail="OpenAI API key not configured"
        )
    
    try:
        agent = get_sales_agent()
        
        conversation_history = [
            {"role": msg.role.value, "content": msg.content}
            for msg in request.conversation_history
        ]
        
        result = await agent.generate(
            business_context=request.business_context,
            conversation_history=conversation_history,
            current_message=request.current_message,
            sender_name=request.sender_name
        )
        
        return GenerateResponse(
            success=True,
            response=result["response"],
            tokens_used=result["tokens_used"],
            model=result["model"],
            tool_calls=[]
        )
        
    except Exception as e:
        logger.error(f"Error generating response: {e}")
        return GenerateResponse(
            success=False,
            error=str(e)
        )


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "service": "EfficoreChat Agent V2",
        "version": "2.0.0",
        "status": "running",
        "endpoints": {
            "health": "/health",
            "generate": "/generate (POST)"
        }
    }


if __name__ == "__main__":
    import uvicorn
    settings = get_settings()
    uvicorn.run(app, host="0.0.0.0", port=settings.port)

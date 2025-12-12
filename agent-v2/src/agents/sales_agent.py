from typing import TypedDict, Annotated, Sequence, List, Dict, Any
from langchain_openai import ChatOpenAI
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, SystemMessage
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from datetime import datetime
import pytz
import logging

from ..config import get_settings, get_v2_model
from ..models.schemas import BusinessContext, Product

logger = logging.getLogger(__name__)


class AgentState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]
    business_context: BusinessContext
    current_time: str
    response: str
    tokens_used: int


def build_system_prompt(context: BusinessContext, current_time: str) -> str:
    """Build the system prompt with business context and dynamic variables."""
    
    products_text = ""
    if context.products:
        products_list = []
        for p in context.products:
            product_info = f"- {p.name}"
            if p.price:
                product_info += f" (Precio: {p.currency} {p.price})"
            if p.description:
                product_info += f": {p.description}"
            if p.stock is not None:
                product_info += f" [Stock: {p.stock}]"
            products_list.append(product_info)
        products_text = "\n".join(products_list)
    
    policies_text = "\n".join([f"- {policy}" for policy in context.policies]) if context.policies else ""
    
    base_prompt = f"""Eres un asistente de ventas profesional para {context.business_name}.

FECHA Y HORA ACTUAL: {current_time}

"""
    
    if context.custom_prompt:
        base_prompt += f"""INSTRUCCIONES DEL NEGOCIO:
{context.custom_prompt}

"""
    
    if products_text:
        base_prompt += f"""PRODUCTOS DISPONIBLES:
{products_text}

"""
    
    if policies_text:
        base_prompt += f"""POLÍTICAS DEL NEGOCIO:
{policies_text}

"""
    
    base_prompt += """DIRECTRICES:
- Responde de manera profesional pero amigable
- Sé conciso y directo
- Si no tienes información sobre algo, indícalo honestamente
- Ayuda al cliente a encontrar lo que necesita
- Usa emojis de forma moderada para hacer la conversación más amena
"""
    
    return base_prompt


def get_current_time_formatted(timezone: str) -> str:
    """Get current time formatted for the specified timezone."""
    try:
        tz = pytz.timezone(timezone)
    except:
        tz = pytz.timezone("America/Lima")
    
    now = datetime.now(tz)
    
    days_es = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]
    months_es = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", 
                 "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"]
    
    day_name = days_es[now.weekday()]
    month_name = months_es[now.month - 1]
    
    return f"{day_name} {now.day} de {month_name} {now.year}, {now.strftime('%H:%M')}"


class SalesAgent:
    def __init__(self):
        self.settings = get_settings()
        self._current_model: str = ""
        self._init_llm()
        self.graph = self._build_graph()
    
    def _init_llm(self):
        """Initialize LLM with current platform model config."""
        platform_model = get_v2_model()
        
        if platform_model != self._current_model:
            logger.info(f"SalesAgent model changed: {self._current_model} -> {platform_model}")
            self._current_model = platform_model
            
            self.llm = ChatOpenAI(
                api_key=self.settings.openai_api_key,
                model=platform_model,
                temperature=0.7
            )
    
    def _ensure_model_current(self):
        """Check if model config changed and refresh if needed."""
        platform_model = get_v2_model()
        if platform_model != self._current_model:
            self._init_llm()
    
    def _build_graph(self) -> StateGraph:
        """Build the LangGraph workflow."""
        
        def generate_response(state: AgentState) -> Dict[str, Any]:
            """Generate AI response based on conversation."""
            context = state["business_context"]
            current_time = state["current_time"]
            
            system_prompt = build_system_prompt(context, current_time)
            
            messages = [SystemMessage(content=system_prompt)]
            messages.extend(state["messages"])
            
            response = self.llm.invoke(messages)
            
            tokens_used = 0
            if hasattr(response, "response_metadata"):
                usage = response.response_metadata.get("token_usage", {})
                tokens_used = usage.get("total_tokens", 0)
            
            return {
                "response": response.content,
                "tokens_used": tokens_used
            }
        
        workflow = StateGraph(AgentState)
        
        workflow.add_node("generate", generate_response)
        
        workflow.set_entry_point("generate")
        workflow.add_edge("generate", END)
        
        return workflow.compile()
    
    async def generate(
        self,
        business_context: BusinessContext,
        conversation_history: List[Dict[str, str]],
        current_message: str,
        sender_name: str | None = None
    ) -> Dict[str, Any]:
        """Generate a response for the given conversation."""
        self._ensure_model_current()
        
        messages = []
        for msg in conversation_history:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "user":
                messages.append(HumanMessage(content=content))
            elif role == "assistant":
                messages.append(AIMessage(content=content))
        
        user_msg = current_message
        if sender_name:
            user_msg = f"[{sender_name}]: {current_message}"
        messages.append(HumanMessage(content=user_msg))
        
        current_time = get_current_time_formatted(business_context.timezone)
        
        initial_state: AgentState = {
            "messages": messages,
            "business_context": business_context,
            "current_time": current_time,
            "response": "",
            "tokens_used": 0
        }
        
        result = self.graph.invoke(initial_state)
        
        return {
            "response": result["response"],
            "tokens_used": result["tokens_used"],
            "model": self._current_model
        }


_agent_instance: SalesAgent | None = None


def get_sales_agent() -> SalesAgent:
    """Get singleton instance of SalesAgent."""
    global _agent_instance
    if _agent_instance is None:
        _agent_instance = SalesAgent()
    return _agent_instance

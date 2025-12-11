from typing import Dict, Any, TypedDict, Annotated, Sequence, Optional, List
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
import logging
import json

from ..schemas.business_profile import BusinessProfile
from ..schemas.vendor_state import AgentAction, ActionType, ObserverOutput
from ..agents.vendor import get_vendor_agent
from ..agents.observer import get_observer_agent
from ..agents.refiner import get_refiner_agent
from .tool_router import ToolRouter, format_tool_result

logger = logging.getLogger(__name__)

MIN_CONTEXT_FOR_OBSERVER = 3
MAX_RETRY_ATTEMPTS = 2


class GraphState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]
    business_profile: Dict[str, Any]
    lead_memory: Dict[str, Any]
    current_message: str
    sender_phone: str
    sender_name: Optional[str]
    embedded_products: list
    knowledge_context: Optional[str]
    dynamic_rules: list
    conversation_history: list
    vendor_action: Optional[Dict[str, Any]]
    tool_result: Optional[str]
    final_response: Optional[str]
    observer_output: Optional[Dict[str, Any]]
    refiner_output: Optional[Dict[str, Any]]
    tokens_used: int
    iteration_count: int
    max_iterations: int
    retry_count: int
    needs_retry: bool
    observer_feedback: Optional[str]


def build_tool_context(state: GraphState) -> Dict[str, Any]:
    """Construye el contexto para el ToolRouter incluyendo custom_tools."""
    business_profile = state.get("business_profile", {})
    return {
        "embedded_products": state.get("embedded_products", []),
        "products": [p.get("product", p) for p in state.get("embedded_products", [])],
        "business_id": business_profile.get("business_id", ""),
        "lead_id": state.get("sender_phone", ""),
        "knowledge_context": state.get("knowledge_context"),
        "custom_tools": business_profile.get("tools_config", [])
    }


async def vendor_node(state: GraphState) -> Dict[str, Any]:
    logger.info("Executing vendor node")
    
    profile = BusinessProfile.from_context(state["business_profile"])
    lead_memory = state["lead_memory"] or {}
    dynamic_rules = state.get("dynamic_rules", [])
    knowledge_context = state.get("knowledge_context")
    observer_feedback = state.get("observer_feedback")
    
    tool_context = build_tool_context(state)
    tool_router = ToolRouter(tool_context)
    tools_available = tool_router.get_available_tools()
    
    vendor = get_vendor_agent()
    action, tokens = await vendor.process(
        current_message=state["current_message"],
        conversation_history=state.get("conversation_history", []),
        business_profile=profile,
        lead_memory=lead_memory,
        dynamic_rules=dynamic_rules,
        tools_available=tools_available,
        sender_name=state.get("sender_name"),
        knowledge_context=knowledge_context,
        observer_feedback=observer_feedback
    )
    
    return {
        "vendor_action": action.model_dump(),
        "tokens_used": state.get("tokens_used", 0) + tokens,
        "iteration_count": state.get("iteration_count", 0) + 1,
        "needs_retry": False,
        "observer_feedback": None
    }


async def tool_router_node(state: GraphState) -> Dict[str, Any]:
    logger.info("Executing tool router node")
    
    vendor_action = state.get("vendor_action", {})
    tool_name = vendor_action.get("nombre_tool")
    tool_input = vendor_action.get("input_tool", {})
    
    if not tool_name:
        return {"tool_result": None}
    
    context = build_tool_context(state)
    
    router = ToolRouter(context)
    result = await router.execute_tool(tool_name, tool_input)
    
    result_text = format_tool_result(result)
    
    return {"tool_result": result_text}


async def vendor_refine_node(state: GraphState) -> Dict[str, Any]:
    """Second pass: Vendor reasons about tool result to craft better response"""
    logger.info("Executing vendor refine node")
    
    vendor_action = state.get("vendor_action", {})
    tool_result = state.get("tool_result")
    
    if not tool_result:
        return {"final_response": vendor_action.get("mensaje", "")}
    
    vendor = get_vendor_agent()
    refined_response, tokens = await vendor.refine_with_tool_result(
        original_message=vendor_action.get("mensaje", ""),
        tool_name=vendor_action.get("nombre_tool", ""),
        tool_result=tool_result,
        current_message=state["current_message"],
        business_profile=BusinessProfile.from_context(state["business_profile"])
    )
    
    return {
        "final_response": refined_response,
        "tokens_used": state.get("tokens_used", 0) + tokens
    }


async def response_builder_node(state: GraphState) -> Dict[str, Any]:
    logger.info("Building final response")
    
    vendor_action = state.get("vendor_action", {})
    
    if vendor_action.get("accion") == "respuesta":
        return {"final_response": vendor_action.get("mensaje", "")}
    
    return {"final_response": vendor_action.get("mensaje", "No pude procesar tu solicitud.")}


async def observer_node(state: GraphState) -> Dict[str, Any]:
    logger.info("Executing observer node")
    
    conversation_history = state.get("conversation_history", [])
    if len(conversation_history) < MIN_CONTEXT_FOR_OBSERVER:
        logger.info(f"Skipping observer - insufficient context ({len(conversation_history)} < {MIN_CONTEXT_FOR_OBSERVER})")
        return {"observer_output": None}
    
    final_response = state.get("final_response", "")
    current_message = state.get("current_message", "")
    
    if not final_response:
        return {"observer_output": None}
    
    observer = get_observer_agent()
    output, tokens = await observer.analyze(
        user_message=current_message,
        agent_response=final_response,
        conversation_context=conversation_history
    )
    
    return {
        "observer_output": output.model_dump(),
        "tokens_used": state.get("tokens_used", 0) + tokens
    }


async def retry_decision_node(state: GraphState) -> Dict[str, Any]:
    """Decide if we need to retry based on observer output"""
    logger.info("Evaluating retry decision")
    
    observer_output = state.get("observer_output")
    retry_count = state.get("retry_count", 0)
    
    if not observer_output or retry_count >= MAX_RETRY_ATTEMPTS:
        return {"needs_retry": False}
    
    observer = ObserverOutput(**observer_output)
    
    critical_keywords = ["no respondió", "ignoró", "información incorrecta", "no mencionó el precio"]
    has_critical_failure = any(
        any(keyword in falla.lower() for keyword in critical_keywords)
        for falla in observer.fallas
    )
    
    if has_critical_failure and observer.fallas:
        feedback = f"CORRECCIÓN NECESARIA: {'; '.join(observer.fallas[:2])}"
        logger.info(f"Triggering retry due to critical failures: {feedback}")
        return {
            "needs_retry": True,
            "observer_feedback": feedback,
            "retry_count": retry_count + 1
        }
    
    return {"needs_retry": False}


async def refiner_node(state: GraphState) -> Dict[str, Any]:
    logger.info("Executing refiner node")
    
    observer_output = state.get("observer_output")
    if not observer_output:
        return {"refiner_output": None}
    
    observer = ObserverOutput(**observer_output)
    
    if not observer.fallas and not observer.recomendaciones:
        return {"refiner_output": None}
    
    business_id = state["business_profile"].get("business_id", "")
    existing_rules = state.get("dynamic_rules", [])
    
    refiner = get_refiner_agent()
    output, tokens = await refiner.refine(
        observer_output=observer,
        business_id=business_id,
        existing_rules=existing_rules
    )
    
    return {
        "refiner_output": output.model_dump(),
        "tokens_used": state.get("tokens_used", 0) + tokens
    }


def should_use_tool(state: GraphState) -> str:
    vendor_action = state.get("vendor_action", {})
    
    if vendor_action.get("accion") == "tool" and vendor_action.get("nombre_tool"):
        return "tool_router"
    return "response_builder"


def should_run_observer(state: GraphState) -> str:
    """Decide if observer should run based on context length"""
    conversation_history = state.get("conversation_history", [])
    if len(conversation_history) >= MIN_CONTEXT_FOR_OBSERVER:
        return "observer"
    return "end"


def should_retry_or_continue(state: GraphState) -> str:
    """After retry decision, either retry vendor or continue to refiner"""
    needs_retry = state.get("needs_retry", False)
    
    if needs_retry:
        return "vendor_retry"
    return "refiner"


def create_agent_graph() -> StateGraph:
    workflow = StateGraph(GraphState)
    
    workflow.add_node("vendor", vendor_node)
    workflow.add_node("tool_router", tool_router_node)
    workflow.add_node("vendor_refine", vendor_refine_node)
    workflow.add_node("response_builder", response_builder_node)
    workflow.add_node("observer", observer_node)
    workflow.add_node("retry_decision", retry_decision_node)
    workflow.add_node("refiner", refiner_node)
    
    workflow.set_entry_point("vendor")
    
    workflow.add_conditional_edges(
        "vendor",
        should_use_tool,
        {
            "tool_router": "tool_router",
            "response_builder": "response_builder"
        }
    )
    
    workflow.add_edge("tool_router", "vendor_refine")
    
    workflow.add_conditional_edges(
        "vendor_refine",
        should_run_observer,
        {
            "observer": "observer",
            "end": END
        }
    )
    
    workflow.add_conditional_edges(
        "response_builder",
        should_run_observer,
        {
            "observer": "observer",
            "end": END
        }
    )
    
    workflow.add_edge("observer", "retry_decision")
    
    workflow.add_conditional_edges(
        "retry_decision",
        should_retry_or_continue,
        {
            "vendor_retry": "vendor",
            "refiner": "refiner"
        }
    )
    
    workflow.add_edge("refiner", END)
    
    return workflow.compile()


_agent_graph = None

def get_agent_graph():
    global _agent_graph
    if _agent_graph is None:
        _agent_graph = create_agent_graph()
    return _agent_graph

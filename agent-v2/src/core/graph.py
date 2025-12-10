from typing import Dict, Any, TypedDict, Annotated, Sequence, Optional
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


class GraphState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]
    business_profile: Dict[str, Any]
    lead_memory: Dict[str, Any]
    current_message: str
    sender_phone: str
    sender_name: Optional[str]
    embedded_products: list
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


async def vendor_node(state: GraphState) -> Dict[str, Any]:
    logger.info("Executing vendor node")
    
    profile = BusinessProfile.from_context(state["business_profile"])
    lead_memory = state["lead_memory"] or {}
    dynamic_rules = state.get("dynamic_rules", [])
    
    tool_router = ToolRouter()
    tools_available = tool_router.get_available_tools()
    
    vendor = get_vendor_agent()
    action, tokens = await vendor.process(
        current_message=state["current_message"],
        conversation_history=state.get("conversation_history", []),
        business_profile=profile,
        lead_memory=lead_memory,
        dynamic_rules=dynamic_rules,
        tools_available=tools_available,
        sender_name=state.get("sender_name")
    )
    
    return {
        "vendor_action": action.model_dump(),
        "tokens_used": state.get("tokens_used", 0) + tokens,
        "iteration_count": state.get("iteration_count", 0) + 1
    }


async def tool_router_node(state: GraphState) -> Dict[str, Any]:
    logger.info("Executing tool router node")
    
    vendor_action = state.get("vendor_action", {})
    tool_name = vendor_action.get("nombre_tool")
    tool_input = vendor_action.get("input_tool", {})
    
    if not tool_name:
        return {"tool_result": None}
    
    context = {
        "embedded_products": state.get("embedded_products", []),
        "products": [p.get("product", p) for p in state.get("embedded_products", [])],
        "business_id": state["business_profile"].get("business_id", ""),
        "lead_id": state["sender_phone"]
    }
    
    router = ToolRouter(context)
    result = await router.execute_tool(tool_name, tool_input)
    
    result_text = format_tool_result(result)
    
    return {"tool_result": result_text}


async def response_builder_node(state: GraphState) -> Dict[str, Any]:
    logger.info("Building final response")
    
    vendor_action = state.get("vendor_action", {})
    tool_result = state.get("tool_result")
    
    if vendor_action.get("accion") == "respuesta":
        return {"final_response": vendor_action.get("mensaje", "")}
    
    if tool_result:
        message = vendor_action.get("mensaje", "")
        if message:
            return {"final_response": f"{message}\n\n{tool_result}"}
        return {"final_response": tool_result}
    
    return {"final_response": vendor_action.get("mensaje", "No pude procesar tu solicitud.")}


async def observer_node(state: GraphState) -> Dict[str, Any]:
    logger.info("Executing observer node")
    
    final_response = state.get("final_response", "")
    current_message = state.get("current_message", "")
    conversation_history = state.get("conversation_history", [])
    
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


def should_continue_after_tool(state: GraphState) -> str:
    iteration_count = state.get("iteration_count", 0)
    max_iterations = state.get("max_iterations", 5)
    
    if iteration_count >= max_iterations:
        return "response_builder"
    
    return "response_builder"


def create_agent_graph() -> StateGraph:
    workflow = StateGraph(GraphState)
    
    workflow.add_node("vendor", vendor_node)
    workflow.add_node("tool_router", tool_router_node)
    workflow.add_node("response_builder", response_builder_node)
    workflow.add_node("observer", observer_node)
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
    
    workflow.add_edge("tool_router", "response_builder")
    
    workflow.add_edge("response_builder", "observer")
    
    workflow.add_edge("observer", "refiner")
    
    workflow.add_edge("refiner", END)
    
    return workflow.compile()


_agent_graph = None

def get_agent_graph():
    global _agent_graph
    if _agent_graph is None:
        _agent_graph = create_agent_graph()
    return _agent_graph

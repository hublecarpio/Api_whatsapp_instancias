"""
FASE 3: LANGGRAPH - TODAS LAS DECISIONES EN EL GRAFO
=====================================================
Nodos implementados:
- load_state: Carga estado comercial
- vendor_response: Vendor solo interpreta
- state_validation: Valida coherencia del estado
- decide_next_action: El GRAFO decide, no el LLM
- execute_tool: Ejecuta tool solo si estado válido
- update_state: Actualiza estado comercial
- finalize_response: Construye respuesta final

REGLA: Ninguna tool se ejecuta si el estado está incompleto.
REGLA: El grafo decide, no el LLM.
"""

from typing import Dict, Any, TypedDict, Annotated, Sequence, Optional, List
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
import logging
import json
from datetime import datetime

from ..schemas.business_profile import BusinessProfile
from ..schemas.vendor_state import (
    AgentAction, ActionType, ObserverOutput,
    CommercialState, VendorOutput, ObserverValidation,
    EtapaComercial, IntencionCliente, ProductoDetectado
)
from ..agents.vendor import get_vendor_agent
from ..agents.observer import get_observer_agent
from ..agents.refiner import get_refiner_agent
from .tool_router import ToolRouter, format_tool_result
from .telemetry import log_tool_execution_fire_and_forget
import time

logger = logging.getLogger(__name__)

MIN_CONTEXT_FOR_OBSERVER = 3
MAX_RETRY_ATTEMPTS = 2


class ToolCallRecord(TypedDict):
    tool_name: str
    tool_input: Dict[str, Any]
    result: str
    success: bool
    error: Optional[str]


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
    
    commercial_state: Optional[Dict[str, Any]]
    vendor_output: Optional[Dict[str, Any]]
    observer_validation: Optional[Dict[str, Any]]
    
    vendor_action: Optional[Dict[str, Any]]
    tool_result: Optional[str]
    tool_success: bool
    tool_error: Optional[str]
    tool_calls: List[ToolCallRecord]
    final_response: Optional[str]
    observer_output: Optional[Dict[str, Any]]
    refiner_output: Optional[Dict[str, Any]]
    tokens_used: int
    iteration_count: int
    max_iterations: int
    retry_count: int
    needs_retry: bool
    observer_feedback: Optional[str]
    
    graph_decision: Optional[str]
    state_valid: bool


def build_tool_context(state: GraphState) -> Dict[str, Any]:
    """Construye el contexto para el ToolRouter."""
    business_profile = state.get("business_profile", {})
    return {
        "embedded_products": state.get("embedded_products", []),
        "products": [p.get("product", p) for p in state.get("embedded_products", [])],
        "business_id": business_profile.get("business_id", ""),
        "lead_id": state.get("sender_phone", ""),
        "knowledge_context": state.get("knowledge_context"),
        "custom_tools": business_profile.get("tools_config", [])
    }


async def load_state_node(state: GraphState) -> Dict[str, Any]:
    """FASE 3: Carga el estado comercial desde memoria."""
    logger.info("Loading commercial state")
    
    lead_memory = state.get("lead_memory", {})
    
    commercial_state = CommercialState(
        etapa_comercial=EtapaComercial(lead_memory.get("current_stage", "nuevo")) 
            if lead_memory.get("current_stage") in [e.value for e in EtapaComercial] 
            else EtapaComercial.NUEVO,
        productos_detectados=[],
        productos_confirmados=[],
        reglas_activas=state.get("dynamic_rules", []),
        ultima_actualizacion=datetime.now().isoformat()
    )
    
    return {
        "commercial_state": commercial_state.model_dump(),
        "state_valid": True
    }


async def vendor_interpret_node(state: GraphState) -> Dict[str, Any]:
    """FASE 3: Vendor solo INTERPRETA, no decide acciones."""
    logger.info("Vendor interpreting message (no actions)")
    
    profile = BusinessProfile.from_context(state["business_profile"])
    lead_memory = state["lead_memory"] or {}
    dynamic_rules = state.get("dynamic_rules", [])
    knowledge_context = state.get("knowledge_context")
    
    vendor = get_vendor_agent()
    
    vendor_output, tokens = await vendor.interpret(
        current_message=state["current_message"],
        conversation_history=state.get("conversation_history", []),
        business_profile=profile,
        lead_memory=lead_memory,
        dynamic_rules=dynamic_rules,
        sender_name=state.get("sender_name"),
        knowledge_context=knowledge_context
    )
    
    return {
        "vendor_output": vendor_output.model_dump(),
        "tokens_used": state.get("tokens_used", 0) + tokens,
        "iteration_count": state.get("iteration_count", 0) + 1
    }


async def state_validation_node(state: GraphState) -> Dict[str, Any]:
    """FASE 3: Valida coherencia del estado antes de continuar."""
    logger.info("Validating state coherence")
    
    vendor_output_data = state.get("vendor_output", {})
    commercial_state_data = state.get("commercial_state", {})
    
    if not vendor_output_data:
        return {"state_valid": False, "observer_validation": None}
    
    vendor_output = VendorOutput(**vendor_output_data)
    commercial_state = CommercialState(**commercial_state_data) if commercial_state_data else None
    
    observer = get_observer_agent()
    validation, tokens = await observer.validate(
        vendor_output=vendor_output,
        commercial_state=commercial_state,
        user_message=state.get("current_message", ""),
        conversation_context=state.get("conversation_history", [])
    )
    
    return {
        "observer_validation": validation.model_dump(),
        "state_valid": validation.estado_valido,
        "tokens_used": state.get("tokens_used", 0) + tokens
    }


async def decide_action_node(state: GraphState) -> Dict[str, Any]:
    """
    FASE 3: EL GRAFO DECIDE, NO EL LLM.
    Basándose en el estado comercial y la validación, decide qué hacer.
    """
    logger.info("Graph deciding next action")
    
    vendor_output_data = state.get("vendor_output", {})
    commercial_state_data = state.get("commercial_state", {})
    validation_data = state.get("observer_validation", {})
    state_valid = state.get("state_valid", True)
    
    if not state_valid:
        logger.warning("State invalid - blocking tool execution")
        return {
            "graph_decision": "response_only",
            "vendor_action": {
                "accion": "respuesta",
                "mensaje": vendor_output_data.get("mensaje", ""),
                "nombre_tool": None,
                "input_tool": None
            }
        }
    
    vendor_output = VendorOutput(**vendor_output_data) if vendor_output_data else None
    commercial_state = CommercialState(**commercial_state_data) if commercial_state_data else None
    
    if not vendor_output:
        return {"graph_decision": "response_only", "vendor_action": None}
    
    if vendor_output.requiere_tool and vendor_output.tool_sugerida:
        tool_name = vendor_output.tool_sugerida
        
        if commercial_state:
            can_execute, reason = commercial_state.can_execute_tool(tool_name)
            if not can_execute:
                logger.warning(f"Tool {tool_name} blocked by state: {reason}")
                return {
                    "graph_decision": "response_only",
                    "vendor_action": {
                        "accion": "respuesta",
                        "mensaje": vendor_output.mensaje,
                        "nombre_tool": None,
                        "input_tool": None
                    }
                }
            
            valid_actions = commercial_state.get_next_valid_actions()
            if tool_name not in valid_actions and tool_name not in ["search_product", "search_knowledge"]:
                logger.warning(f"Tool {tool_name} not valid for current stage")
                return {
                    "graph_decision": "response_only",
                    "vendor_action": {
                        "accion": "respuesta",
                        "mensaje": vendor_output.mensaje,
                        "nombre_tool": None,
                        "input_tool": None
                    }
                }
        
        return {
            "graph_decision": "execute_tool",
            "vendor_action": {
                "accion": "tool",
                "mensaje": vendor_output.mensaje,
                "nombre_tool": tool_name,
                "input_tool": vendor_output.tool_params_sugeridos or {}
            }
        }
    
    return {
        "graph_decision": "response_only",
        "vendor_action": {
            "accion": "respuesta",
            "mensaje": vendor_output.mensaje,
            "nombre_tool": None,
            "input_tool": None
        }
    }


async def execute_tool_node(state: GraphState) -> Dict[str, Any]:
    """FASE 3: Ejecuta tool SOLO si el estado es válido."""
    logger.info("Executing tool (state-validated)")
    
    if not state.get("state_valid", True):
        logger.warning("Skipping tool execution - state invalid")
        return {
            "tool_result": None,
            "tool_success": False,
            "tool_error": "State validation failed"
        }
    
    vendor_action = state.get("vendor_action", {})
    tool_name = vendor_action.get("nombre_tool")
    tool_input = vendor_action.get("input_tool", {})
    
    if not tool_name:
        return {"tool_result": None, "tool_success": True, "tool_error": None}
    
    context = build_tool_context(state)
    router = ToolRouter(context)
    
    is_valid, error = router.validate_tool_call(tool_name, tool_input)
    if not is_valid:
        logger.warning(f"Tool call validation failed: {error}")
        return {
            "tool_result": f"Parámetros inválidos: {error}",
            "tool_success": False,
            "tool_error": error
        }
    
    start_time = time.time()
    result = await router.execute_tool(tool_name, tool_input)
    duration_ms = int((time.time() - start_time) * 1000)
    
    result_text = format_tool_result(result)
    tool_success = result.get("success", False)
    tool_error = result.get("error") if not tool_success else None
    
    business_id = state.get("business_profile", {}).get("business_id", "")
    contact_phone = state.get("sender_phone")
    
    log_tool_execution_fire_and_forget(
        business_id=business_id,
        tool_name=tool_name,
        tool_input=tool_input or {},
        result=result_text,
        success=tool_success,
        error=tool_error,
        duration_ms=duration_ms,
        contact_phone=contact_phone
    )
    
    tool_call_record: ToolCallRecord = {
        "tool_name": tool_name,
        "tool_input": tool_input or {},
        "result": result_text,
        "success": tool_success,
        "error": tool_error
    }
    
    existing_calls = list(state.get("tool_calls", []))
    existing_calls.append(tool_call_record)
    
    logger.info(f"Tool {tool_name} executed: success={tool_success}, duration={duration_ms}ms")
    
    return {
        "tool_result": result_text,
        "tool_success": tool_success,
        "tool_error": tool_error,
        "tool_calls": existing_calls
    }


async def update_state_node(state: GraphState) -> Dict[str, Any]:
    """FASE 3: Actualiza el estado comercial basado en la interacción."""
    logger.info("Updating commercial state")
    
    commercial_state_data = state.get("commercial_state", {})
    vendor_output_data = state.get("vendor_output", {})
    tool_success = state.get("tool_success", True)
    
    if not commercial_state_data:
        return {}
    
    commercial_state = CommercialState(**commercial_state_data)
    vendor_output = VendorOutput(**vendor_output_data) if vendor_output_data else None
    
    if vendor_output:
        commercial_state.intencion_actual = vendor_output.intencion
        
        if vendor_output.intencion == IntencionCliente.CONSULTA_PRODUCTO:
            if commercial_state.etapa_comercial == EtapaComercial.NUEVO:
                commercial_state.etapa_comercial = EtapaComercial.EXPLORANDO
        elif vendor_output.intencion == IntencionCliente.INTENCION_COMPRA:
            commercial_state.etapa_comercial = EtapaComercial.INTERESADO
        elif vendor_output.intencion == IntencionCliente.CONFIRMACION_COMPRA:
            if commercial_state.productos_confirmados:
                commercial_state.etapa_comercial = EtapaComercial.CONFIRMANDO
    
    if state.get("vendor_action", {}).get("nombre_tool") == "payment" and tool_success:
        commercial_state.etapa_comercial = EtapaComercial.PAGANDO
    
    commercial_state.ultima_actualizacion = datetime.now().isoformat()
    
    return {"commercial_state": commercial_state.model_dump()}


async def finalize_response_node(state: GraphState) -> Dict[str, Any]:
    """FASE 3: Construye la respuesta final."""
    logger.info("Finalizing response")
    
    vendor_action = state.get("vendor_action", {})
    tool_result = state.get("tool_result")
    tool_success = state.get("tool_success", True)
    
    if vendor_action.get("accion") == "respuesta" or not tool_result:
        return {"final_response": vendor_action.get("mensaje", "")}
    
    vendor = get_vendor_agent()
    refined_response, tokens = await vendor.refine_with_tool_result(
        original_message=vendor_action.get("mensaje", ""),
        tool_name=vendor_action.get("nombre_tool", ""),
        tool_result=tool_result,
        current_message=state["current_message"],
        business_profile=BusinessProfile.from_context(state["business_profile"]),
        tool_failed=not tool_success
    )
    
    return {
        "final_response": refined_response,
        "tokens_used": state.get("tokens_used", 0) + tokens
    }


async def vendor_node(state: GraphState) -> Dict[str, Any]:
    """Legacy vendor node for backward compatibility."""
    logger.info("Executing vendor node (legacy)")
    
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
    """Legacy tool router node."""
    logger.info("Executing tool router node")
    
    vendor_action = state.get("vendor_action", {})
    tool_name = vendor_action.get("nombre_tool")
    tool_input = vendor_action.get("input_tool", {})
    
    if not tool_name:
        return {"tool_result": None, "tool_success": True, "tool_error": None}
    
    context = build_tool_context(state)
    router = ToolRouter(context)
    result = await router.execute_tool(tool_name, tool_input)
    
    result_text = format_tool_result(result)
    tool_success = result.get("success", False)
    tool_error = result.get("error") if not tool_success else None
    
    tool_call_record: ToolCallRecord = {
        "tool_name": tool_name,
        "tool_input": tool_input or {},
        "result": result_text,
        "success": tool_success,
        "error": tool_error
    }
    
    existing_calls = list(state.get("tool_calls", []))
    existing_calls.append(tool_call_record)
    
    return {
        "tool_result": result_text,
        "tool_success": tool_success,
        "tool_error": tool_error,
        "tool_calls": existing_calls
    }


async def vendor_refine_node(state: GraphState) -> Dict[str, Any]:
    """Legacy vendor refine node."""
    logger.info("Executing vendor refine node")
    
    vendor_action = state.get("vendor_action", {})
    tool_result = state.get("tool_result")
    tool_success = state.get("tool_success", True)
    tool_error = state.get("tool_error")
    
    if not tool_result:
        return {"final_response": vendor_action.get("mensaje", "")}
    
    if not tool_success and tool_error:
        error_context = f"La herramienta falló: {tool_error}. Resultado: {tool_result}"
    else:
        error_context = None
    
    vendor = get_vendor_agent()
    refined_response, tokens = await vendor.refine_with_tool_result(
        original_message=vendor_action.get("mensaje", ""),
        tool_name=vendor_action.get("nombre_tool", ""),
        tool_result=tool_result if not error_context else error_context,
        current_message=state["current_message"],
        business_profile=BusinessProfile.from_context(state["business_profile"]),
        tool_failed=not tool_success
    )
    
    return {
        "final_response": refined_response,
        "tokens_used": state.get("tokens_used", 0) + tokens
    }


async def response_builder_node(state: GraphState) -> Dict[str, Any]:
    """Legacy response builder."""
    logger.info("Building final response")
    vendor_action = state.get("vendor_action", {})
    
    if vendor_action.get("accion") == "respuesta":
        return {"final_response": vendor_action.get("mensaje", "")}
    
    return {"final_response": vendor_action.get("mensaje", "No pude procesar tu solicitud.")}


async def observer_node(state: GraphState) -> Dict[str, Any]:
    """Legacy observer node."""
    logger.info("Executing observer node")
    
    conversation_history = state.get("conversation_history", [])
    if len(conversation_history) < MIN_CONTEXT_FOR_OBSERVER:
        return {"observer_output": None}
    
    final_response = state.get("final_response", "")
    if not final_response:
        return {"observer_output": None}
    
    observer = get_observer_agent()
    output, tokens = await observer.analyze(
        user_message=state.get("current_message", ""),
        agent_response=final_response,
        conversation_context=conversation_history
    )
    
    return {
        "observer_output": output.model_dump(),
        "tokens_used": state.get("tokens_used", 0) + tokens
    }


async def retry_decision_node(state: GraphState) -> Dict[str, Any]:
    """Legacy retry decision."""
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
        return {
            "needs_retry": True,
            "observer_feedback": feedback,
            "retry_count": retry_count + 1,
            "final_response": None,
            "vendor_action": None
        }
    
    return {"needs_retry": False}


async def refiner_node(state: GraphState) -> Dict[str, Any]:
    """Legacy refiner node."""
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
    conversation_history = state.get("conversation_history", [])
    if len(conversation_history) >= MIN_CONTEXT_FOR_OBSERVER:
        return "observer"
    return "end"


def should_retry_or_continue(state: GraphState) -> str:
    if state.get("needs_retry", False):
        return "vendor_retry"
    return "refiner"


def should_execute_tool_v2(state: GraphState) -> str:
    """V2: Decide based on graph_decision."""
    decision = state.get("graph_decision", "response_only")
    if decision == "execute_tool":
        return "execute_tool"
    return "finalize"


def create_agent_graph() -> StateGraph:
    """Creates the legacy graph for backward compatibility."""
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
        {"tool_router": "tool_router", "response_builder": "response_builder"}
    )
    
    workflow.add_edge("tool_router", "vendor_refine")
    
    workflow.add_conditional_edges(
        "vendor_refine",
        should_run_observer,
        {"observer": "observer", "end": END}
    )
    
    workflow.add_conditional_edges(
        "response_builder",
        should_run_observer,
        {"observer": "observer", "end": END}
    )
    
    workflow.add_edge("observer", "retry_decision")
    
    workflow.add_conditional_edges(
        "retry_decision",
        should_retry_or_continue,
        {"vendor_retry": "vendor", "refiner": "refiner"}
    )
    
    workflow.add_edge("refiner", END)
    
    return workflow.compile()


def create_state_governed_graph() -> StateGraph:
    """
    FASE 3: Creates the new state-governed graph.
    This is the hardened version where:
    - The graph decides, not the LLM
    - No tool executes without state validation
    - State is the supreme law
    """
    workflow = StateGraph(GraphState)
    
    workflow.add_node("load_state", load_state_node)
    workflow.add_node("vendor_interpret", vendor_interpret_node)
    workflow.add_node("state_validation", state_validation_node)
    workflow.add_node("decide_action", decide_action_node)
    workflow.add_node("execute_tool", execute_tool_node)
    workflow.add_node("update_state", update_state_node)
    workflow.add_node("finalize", finalize_response_node)
    workflow.add_node("refiner", refiner_node)
    
    workflow.set_entry_point("load_state")
    
    workflow.add_edge("load_state", "vendor_interpret")
    workflow.add_edge("vendor_interpret", "state_validation")
    workflow.add_edge("state_validation", "decide_action")
    
    workflow.add_conditional_edges(
        "decide_action",
        should_execute_tool_v2,
        {"execute_tool": "execute_tool", "finalize": "finalize"}
    )
    
    workflow.add_edge("execute_tool", "update_state")
    workflow.add_edge("update_state", "finalize")
    workflow.add_edge("finalize", "refiner")
    workflow.add_edge("refiner", END)
    
    return workflow.compile()


_agent_graph = None
_state_governed_graph = None


def get_agent_graph():
    """Returns the legacy graph (default)."""
    global _agent_graph
    if _agent_graph is None:
        _agent_graph = create_agent_graph()
    return _agent_graph


def get_state_governed_graph():
    """Returns the new state-governed graph (V2 hardened)."""
    global _state_governed_graph
    if _state_governed_graph is None:
        _state_governed_graph = create_state_governed_graph()
    return _state_governed_graph

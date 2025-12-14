"""
Tests de integración para la máquina de estados del Agent V2.
Validan persistencia de estado, transiciones de etapas y flujo ReAct.
"""

import pytest
from unittest.mock import patch, MagicMock, AsyncMock
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from schemas.vendor_state import (
    CommercialState, EtapaComercial, IntencionCliente,
    ProductoDetectado, STAGE_TRANSITIONS, STAGE_TOOLS, TOOL_PRECONDITIONS
)


class TestCommercialStateTransitions:
    """Tests para transiciones de etapas comerciales."""
    
    def test_valid_transition_nuevo_to_explorando(self):
        """Transición válida: nuevo → explorando."""
        state = CommercialState(etapa_comercial=EtapaComercial.NUEVO)
        can_transition, error = state.can_transition_to(EtapaComercial.EXPLORANDO)
        assert can_transition is True
        assert error is None
    
    def test_valid_transition_nuevo_to_interesado(self):
        """Transición válida: nuevo → interesado."""
        state = CommercialState(etapa_comercial=EtapaComercial.NUEVO)
        can_transition, error = state.can_transition_to(EtapaComercial.INTERESADO)
        assert can_transition is True
    
    def test_invalid_transition_nuevo_to_pagando(self):
        """Transición inválida: nuevo → pagando."""
        state = CommercialState(etapa_comercial=EtapaComercial.NUEVO)
        can_transition, error = state.can_transition_to(EtapaComercial.PAGANDO)
        assert can_transition is False
        assert "Transición inválida" in error
    
    def test_transition_to_success(self):
        """transition_to cambia el estado correctamente."""
        state = CommercialState(etapa_comercial=EtapaComercial.NUEVO)
        success, error = state.transition_to(EtapaComercial.EXPLORANDO)
        assert success is True
        assert state.etapa_comercial == EtapaComercial.EXPLORANDO
    
    def test_transition_to_failure(self):
        """transition_to no cambia el estado si es inválida."""
        state = CommercialState(etapa_comercial=EtapaComercial.NUEVO)
        original_stage = state.etapa_comercial
        success, error = state.transition_to(EtapaComercial.COMPLETADO)
        assert success is False
        assert state.etapa_comercial == original_stage
    
    def test_completado_has_no_transitions(self):
        """Estado completado no tiene transiciones válidas."""
        state = CommercialState(etapa_comercial=EtapaComercial.COMPLETADO)
        valid_transitions = state.get_valid_transitions()
        assert valid_transitions == []
    
    def test_abandonado_can_restart(self):
        """Estado abandonado puede volver a nuevo."""
        state = CommercialState(etapa_comercial=EtapaComercial.ABANDONADO)
        can_transition, error = state.can_transition_to(EtapaComercial.NUEVO)
        assert can_transition is True


class TestToolValidation:
    """Tests para validación de herramientas por etapa."""
    
    def test_search_product_available_in_nuevo(self):
        """search_product disponible en etapa nuevo."""
        state = CommercialState(etapa_comercial=EtapaComercial.NUEVO)
        can_execute, error = state.can_execute_tool("search_product")
        assert can_execute is True
    
    def test_payment_not_available_in_nuevo(self):
        """payment no disponible en etapa nuevo."""
        state = CommercialState(etapa_comercial=EtapaComercial.NUEVO)
        can_execute, error = state.can_execute_tool("payment")
        assert can_execute is False
    
    def test_payment_requires_productos_confirmados(self):
        """payment requiere productos confirmados."""
        state = CommercialState(
            etapa_comercial=EtapaComercial.CONFIRMANDO,
            productos_confirmados=[]
        )
        can_execute, error = state.can_execute_tool("payment")
        assert can_execute is False
        assert "productos confirmados" in error.lower()
    
    def test_payment_requires_total(self):
        """payment requiere total calculado."""
        state = CommercialState(
            etapa_comercial=EtapaComercial.CONFIRMANDO,
            productos_confirmados=[ProductoDetectado(product_id="1", nombre="Test", cantidad=1)],
            total_calculado=None
        )
        can_execute, error = state.can_execute_tool("payment")
        assert can_execute is False
        assert "total" in error.lower()
    
    def test_payment_success_with_all_requirements(self):
        """payment permitido con todos los requisitos."""
        state = CommercialState(
            etapa_comercial=EtapaComercial.CONFIRMANDO,
            productos_confirmados=[ProductoDetectado(product_id="1", nombre="Test", cantidad=1)],
            total_calculado=100.0
        )
        can_execute, error = state.can_execute_tool("payment")
        assert can_execute is True
    
    def test_followup_available_in_explorando(self):
        """followup disponible en explorando (alineado con TOOL_PRECONDITIONS)."""
        state = CommercialState(etapa_comercial=EtapaComercial.EXPLORANDO)
        can_execute, error = state.can_execute_tool("followup")
        assert can_execute is True
    
    def test_crm_available_in_pagando(self):
        """crm disponible en pagando (alineado con TOOL_PRECONDITIONS)."""
        state = CommercialState(etapa_comercial=EtapaComercial.PAGANDO)
        can_execute, error = state.can_execute_tool("crm")
        assert can_execute is True
    
    def test_invalid_state_blocks_all_tools(self):
        """Estado inválido bloquea todas las herramientas."""
        state = CommercialState(
            etapa_comercial=EtapaComercial.EXPLORANDO,
            estado_valido=False
        )
        can_execute, error = state.can_execute_tool("search_product")
        assert can_execute is False
        assert "inválido" in error.lower()


class TestStageToolsAlignment:
    """Tests para verificar alineación STAGE_TOOLS con TOOL_PRECONDITIONS."""
    
    def test_followup_in_all_allowed_stages(self):
        """followup está en STAGE_TOOLS para todas las etapas de allowed_stages."""
        allowed_stages = TOOL_PRECONDITIONS["followup"]["allowed_stages"]
        for stage in allowed_stages:
            assert "followup" in STAGE_TOOLS[stage], f"followup missing in {stage}"
    
    def test_crm_in_all_allowed_stages(self):
        """crm está en STAGE_TOOLS para todas las etapas de allowed_stages."""
        allowed_stages = TOOL_PRECONDITIONS["crm"]["allowed_stages"]
        for stage in allowed_stages:
            assert "crm" in STAGE_TOOLS[stage], f"crm missing in {stage}"
    
    def test_media_in_all_allowed_stages(self):
        """media está en STAGE_TOOLS para todas las etapas de allowed_stages."""
        allowed_stages = TOOL_PRECONDITIONS["media"]["allowed_stages"]
        for stage in allowed_stages:
            assert "media" in STAGE_TOOLS[stage], f"media missing in {stage}"
    
    def test_payment_only_in_confirmando(self):
        """payment solo está en STAGE_TOOLS para confirmando."""
        for stage, tools in STAGE_TOOLS.items():
            if stage == "confirmando":
                assert "payment" in tools
            else:
                assert "payment" not in tools, f"payment should not be in {stage}"


class TestGetNextValidActions:
    """Tests para get_next_valid_actions."""
    
    def test_respuesta_always_included(self):
        """respuesta siempre está incluida."""
        state = CommercialState(etapa_comercial=EtapaComercial.NUEVO)
        actions = state.get_next_valid_actions()
        assert "respuesta" in actions
    
    def test_nuevo_stage_valid_actions(self):
        """Acciones válidas en etapa nuevo."""
        state = CommercialState(etapa_comercial=EtapaComercial.NUEVO)
        actions = state.get_next_valid_actions()
        assert "search_product" in actions
        assert "search_knowledge" in actions
        assert "payment" not in actions


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

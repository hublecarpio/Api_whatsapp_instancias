"""
Configuración de pytest para Agent V2.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest

@pytest.fixture
def sample_commercial_state():
    """Fixture para crear un CommercialState de prueba."""
    from schemas.vendor_state import CommercialState, EtapaComercial
    return CommercialState(etapa_comercial=EtapaComercial.NUEVO)

@pytest.fixture
def sample_product():
    """Fixture para crear un ProductoDetectado de prueba."""
    from schemas.vendor_state import ProductoDetectado
    return ProductoDetectado(
        product_id="test-123",
        nombre="Producto Test",
        cantidad=2,
        precio_unitario=50.0,
        confirmado=True
    )

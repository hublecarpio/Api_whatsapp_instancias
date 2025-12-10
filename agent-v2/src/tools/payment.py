from typing import Dict, Any
import httpx
import logging

from ..schemas.tool_schemas import PaymentInput, PaymentOutput
from ..config import get_settings

logger = logging.getLogger(__name__)


class PaymentTool:
    name = "payment"
    description = "Genera un link de pago para un producto usando el Core API"
    
    @staticmethod
    async def run(input_data: PaymentInput) -> PaymentOutput:
        settings = get_settings()
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{settings.core_api_url}/orders/create-payment-link",
                    json={
                        "businessId": input_data.business_id,
                        "productId": input_data.product_id,
                        "quantity": input_data.quantity,
                        "leadId": input_data.lead_id
                    },
                    headers={
                        "Content-Type": "application/json",
                        "X-Internal-Secret": settings.internal_agent_secret
                    }
                )
                
                if response.status_code == 200:
                    data = response.json()
                    return PaymentOutput(
                        success=True,
                        payment_url=data.get("paymentUrl"),
                        short_code=data.get("shortCode"),
                        message="Link de pago generado exitosamente"
                    )
                else:
                    error_data = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
                    return PaymentOutput(
                        success=False,
                        error=error_data.get("error", f"HTTP {response.status_code}"),
                        message="Error al generar link de pago"
                    )
                    
        except httpx.TimeoutException:
            return PaymentOutput(
                success=False,
                error="Timeout al conectar con Core API",
                message="El servidor tardó demasiado en responder"
            )
        except Exception as e:
            logger.error(f"Error in payment tool: {e}")
            return PaymentOutput(
                success=False,
                error=str(e),
                message="Error al generar link de pago"
            )

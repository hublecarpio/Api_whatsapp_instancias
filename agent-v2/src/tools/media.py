from typing import Dict, Any, List, Optional
import logging

from ..schemas.tool_schemas import MediaInput, MediaOutput

logger = logging.getLogger(__name__)


class MediaTool:
    name = "media"
    description = "Obtiene URLs de imágenes, PDFs u otros recursos del negocio"
    
    @staticmethod
    async def run(
        input_data: MediaInput,
        products: Optional[List[Dict[str, Any]]] = None,
        media_resources: Optional[Dict[str, str]] = None
    ) -> MediaOutput:
        try:
            if input_data.product_id and products:
                product = next(
                    (p for p in products if p.get("id") == input_data.product_id),
                    None
                )
                
                if product:
                    image_url = product.get("image_url") or product.get("imageUrl")
                    if image_url:
                        return MediaOutput(
                            success=True,
                            media_url=image_url,
                            media_type="image",
                            file_name=f"{product.get('name', 'product')}.jpg",
                            message=f"Imagen del producto: {product.get('name')}"
                        )
                    else:
                        return MediaOutput(
                            success=False,
                            message=f"El producto '{product.get('name')}' no tiene imagen disponible"
                        )
                else:
                    return MediaOutput(
                        success=False,
                        message=f"No se encontró el producto con ID: {input_data.product_id}"
                    )
            
            if input_data.resource_name and media_resources:
                resource_url = media_resources.get(input_data.resource_name)
                if resource_url:
                    return MediaOutput(
                        success=True,
                        media_url=resource_url,
                        media_type=input_data.media_type,
                        file_name=input_data.resource_name,
                        message=f"Recurso encontrado: {input_data.resource_name}"
                    )
                else:
                    return MediaOutput(
                        success=False,
                        message=f"No se encontró el recurso: {input_data.resource_name}"
                    )
            
            if input_data.media_type == "catalog":
                return MediaOutput(
                    success=True,
                    media_type="catalog",
                    message="El catálogo está disponible en los productos listados"
                )
            
            return MediaOutput(
                success=False,
                message="Se requiere product_id o resource_name para obtener media"
            )
            
        except Exception as e:
            logger.error(f"Error in media tool: {e}")
            return MediaOutput(
                success=False,
                message=f"Error al obtener media: {str(e)}"
            )

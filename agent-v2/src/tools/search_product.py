from typing import Dict, Any, List, Optional
import logging

from ..schemas.tool_schemas import SearchProductInput, SearchProductOutput
from ..core.embeddings import get_embedding_service

logger = logging.getLogger(__name__)


class SearchProductTool:
    name = "search_product"
    description = "Busca productos en el catálogo usando búsqueda semántica inteligente"
    
    @staticmethod
    async def run(
        input_data: SearchProductInput,
        embedded_products: List[Dict[str, Any]]
    ) -> SearchProductOutput:
        try:
            if not embedded_products:
                return SearchProductOutput(
                    success=False,
                    products=[],
                    message="No hay productos disponibles en el catálogo"
                )
            
            embedding_service = get_embedding_service()
            
            results = embedding_service.search_similarity(
                query=input_data.query,
                embedded_products=embedded_products,
                top_n=input_data.max_results
            )
            
            if not results:
                return SearchProductOutput(
                    success=True,
                    products=[],
                    message=f"No se encontraron productos para '{input_data.query}'"
                )
            
            products = [product for product, score in results]
            best_match = products[0] if products else None
            best_score = results[0][1] if results else None
            
            return SearchProductOutput(
                success=True,
                products=products,
                best_match=best_match,
                similarity_score=best_score,
                message=f"Se encontraron {len(products)} productos"
            )
            
        except Exception as e:
            logger.error(f"Error in search_product: {e}")
            return SearchProductOutput(
                success=False,
                products=[],
                message=f"Error al buscar productos: {str(e)}"
            )

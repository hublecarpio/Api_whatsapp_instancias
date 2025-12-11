from typing import Dict, Any, Optional
import logging
import httpx

from ..schemas.tool_schemas import SearchKnowledgeInput, SearchKnowledgeOutput
from ..config import get_settings

logger = logging.getLogger(__name__)


class SearchKnowledgeTool:
    name = "search_knowledge"
    description = "Busca en la base de conocimiento del negocio para encontrar información sobre políticas, FAQs, guías y documentación"

    @staticmethod
    async def run(
        input_data: SearchKnowledgeInput,
        context: Dict[str, Any]
    ) -> SearchKnowledgeOutput:
        try:
            settings = get_settings()
            business_id = context.get("business_id", "")

            if not business_id:
                return SearchKnowledgeOutput(
                    success=False,
                    results=[],
                    message="Business ID no disponible"
                )

            url = f"{settings.core_api_url}/knowledge/{business_id}/search"

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    url,
                    json={
                        "query": input_data.query,
                        "limit": input_data.max_results
                    },
                    headers={
                        "X-Internal-Agent-Secret": settings.internal_agent_secret
                    }
                )

                if response.status_code == 200:
                    data = response.json()
                    results = data.get("results", [])
                    context_text = data.get("context", "")

                    if not results:
                        return SearchKnowledgeOutput(
                            success=True,
                            results=[],
                            context=None,
                            message=f"No se encontró información sobre '{input_data.query}'"
                        )

                    return SearchKnowledgeOutput(
                        success=True,
                        results=results,
                        context=context_text,
                        message=f"Se encontraron {len(results)} documentos relevantes"
                    )
                else:
                    logger.warning(f"Knowledge search failed: {response.status_code}")
                    return SearchKnowledgeOutput(
                        success=False,
                        results=[],
                        message="Error al buscar en la base de conocimiento"
                    )

        except Exception as e:
            logger.error(f"Error in search_knowledge: {e}")
            return SearchKnowledgeOutput(
                success=False,
                results=[],
                message=f"Error al buscar: {str(e)}"
            )

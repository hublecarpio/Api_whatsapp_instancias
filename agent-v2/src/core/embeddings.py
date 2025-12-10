import numpy as np
from typing import List, Dict, Any, Optional, Tuple
from openai import OpenAI
import logging

from ..config import get_settings
from ..schemas.business_profile import Product

logger = logging.getLogger(__name__)


class EmbeddingService:
    def __init__(self):
        settings = get_settings()
        self.client = OpenAI(api_key=settings.openai_api_key) if settings.openai_api_key else None
        self.model = "text-embedding-3-small"
        self._cache: Dict[str, List[float]] = {}
    
    def _get_embedding(self, text: str) -> List[float]:
        if not self.client:
            raise ValueError("OpenAI client not initialized")
        
        if text in self._cache:
            return self._cache[text]
        
        try:
            response = self.client.embeddings.create(
                model=self.model,
                input=text
            )
            embedding = response.data[0].embedding
            self._cache[text] = embedding
            return embedding
        except Exception as e:
            logger.error(f"Error generating embedding: {e}")
            raise
    
    def embed_products(self, products: List[Product]) -> List[Dict[str, Any]]:
        embedded_products = []
        
        for product in products:
            text_parts = [product.name]
            if product.description:
                text_parts.append(product.description)
            if product.category:
                text_parts.append(product.category)
            if product.attributes:
                for key, value in product.attributes.items():
                    text_parts.append(f"{key}: {value}")
            
            text = " ".join(text_parts)
            
            try:
                embedding = self._get_embedding(text)
                embedded_products.append({
                    "product": product.model_dump(),
                    "embedding": embedding,
                    "text": text
                })
            except Exception as e:
                logger.warning(f"Could not embed product {product.id}: {e}")
                embedded_products.append({
                    "product": product.model_dump(),
                    "embedding": None,
                    "text": text
                })
        
        return embedded_products
    
    def search_similarity(
        self, 
        query: str, 
        embedded_products: List[Dict[str, Any]],
        top_n: int = 5
    ) -> List[Tuple[Dict[str, Any], float]]:
        if not embedded_products:
            return []
        
        try:
            query_embedding = self._get_embedding(query)
        except Exception as e:
            logger.error(f"Error embedding query: {e}")
            return self._fallback_search(query, embedded_products, top_n)
        
        results = []
        for item in embedded_products:
            if item.get("embedding") is None:
                continue
            
            similarity = self._cosine_similarity(query_embedding, item["embedding"])
            results.append((item["product"], similarity))
        
        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_n]
    
    def _cosine_similarity(self, a: List[float], b: List[float]) -> float:
        a_np = np.array(a)
        b_np = np.array(b)
        
        dot_product = np.dot(a_np, b_np)
        norm_a = np.linalg.norm(a_np)
        norm_b = np.linalg.norm(b_np)
        
        if norm_a == 0 or norm_b == 0:
            return 0.0
        
        return float(dot_product / (norm_a * norm_b))
    
    def _fallback_search(
        self, 
        query: str, 
        embedded_products: List[Dict[str, Any]],
        top_n: int
    ) -> List[Tuple[Dict[str, Any], float]]:
        query_lower = query.lower()
        query_words = set(query_lower.split())
        
        results = []
        for item in embedded_products:
            product = item["product"]
            text = item.get("text", "").lower()
            
            word_matches = sum(1 for word in query_words if word in text)
            score = word_matches / len(query_words) if query_words else 0
            
            if query_lower in text:
                score += 0.5
            
            results.append((product, min(score, 1.0)))
        
        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_n]
    
    def clear_cache(self):
        self._cache.clear()


_embedding_service: Optional[EmbeddingService] = None

def get_embedding_service() -> EmbeddingService:
    global _embedding_service
    if _embedding_service is None:
        _embedding_service = EmbeddingService()
    return _embedding_service

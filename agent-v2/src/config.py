from pydantic_settings import BaseSettings
from functools import lru_cache
from typing import Optional, Literal
import httpx
import time
import logging

logger = logging.getLogger(__name__)

ReasoningEffort = Literal["none", "low", "medium", "high", "xhigh"]


class Settings(BaseSettings):
    openai_api_key: str = ""
    openai_model: str = "gpt-4o"
    
    vendor_model: str = "gpt-4o"
    refine_model: str = "gpt-4o-mini"
    observer_model: str = "gpt-4o-mini"
    refiner_model: str = "gpt-4o-mini"
    embedding_model: str = "text-embedding-3-small"
    
    database_url: str = ""
    redis_url: str = ""
    core_api_url: str = "http://localhost:3001"
    internal_agent_secret: str = "internal-agent-secret-change-me"
    
    port: int = 5001
    debug: bool = False
    
    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


_platform_config: Optional[dict] = None
_config_fetch_time: float = 0
CONFIG_CACHE_TTL = 60.0


def fetch_platform_model_config() -> dict:
    """Fetch model configuration from Core API (cached for 60s)."""
    global _platform_config, _config_fetch_time
    
    now = time.time()
    if _platform_config and (now - _config_fetch_time) < CONFIG_CACHE_TTL:
        return _platform_config
    
    settings = get_settings()
    
    try:
        with httpx.Client(timeout=5.0) as client:
            response = client.get(
                f"{settings.core_api_url}/super-admin/internal/model-config",
                headers={"X-Internal-Secret": settings.internal_agent_secret}
            )
            
            if response.status_code == 200:
                _platform_config = response.json()
                _config_fetch_time = now
                logger.info(f"Fetched platform config: V2 model = {_platform_config.get('v2', {}).get('model')}")
                return _platform_config
    except Exception as e:
        logger.warning(f"Failed to fetch platform config: {e}")
    
    return {
        "v2": {
            "model": settings.openai_model,
            "reasoningEffort": "none"
        }
    }


def get_v2_model() -> str:
    """Get the configured model for Agent V2."""
    config = fetch_platform_model_config()
    return config.get("v2", {}).get("model", "gpt-4o")


def get_v2_reasoning_effort() -> ReasoningEffort:
    """Get the configured reasoning effort for Agent V2."""
    config = fetch_platform_model_config()
    return config.get("v2", {}).get("reasoningEffort", "none")

from pydantic_settings import BaseSettings
from functools import lru_cache


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

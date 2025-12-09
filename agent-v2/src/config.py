from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    
    database_url: str = ""
    redis_url: str = ""
    core_api_url: str = "http://localhost:3001"
    
    port: int = 5001
    debug: bool = False
    
    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()

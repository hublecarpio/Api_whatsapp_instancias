"""
Unified OpenAI API wrapper that supports both Chat Completions and Responses API.
Routes GPT-5+ models to Responses API with optional reasoning, GPT-4 to Chat Completions.
"""

import httpx
from openai import OpenAI
from typing import Optional, List, Dict, Any, Literal
from dataclasses import dataclass
import logging

from ..config import get_settings

logger = logging.getLogger(__name__)

ReasoningEffort = Literal["none", "low", "medium", "high", "xhigh"]

GPT5_MODEL_PREFIXES = ["gpt-5", "o1", "o3"]

def is_gpt5_model(model: str) -> bool:
    """Check if model requires Responses API."""
    return any(model.startswith(prefix) for prefix in GPT5_MODEL_PREFIXES)


@dataclass
class ModelConfig:
    model: str
    reasoning_effort: ReasoningEffort


@dataclass
class OpenAIResult:
    content: str
    tokens_used: int
    model: str
    reasoning_used: bool


_cached_config: Optional[Dict[str, Any]] = None
_cache_time: float = 0
CACHE_TTL = 60.0


async def fetch_model_config() -> ModelConfig:
    """Fetch model configuration from Core API."""
    global _cached_config, _cache_time
    
    import time
    now = time.time()
    
    if _cached_config and (now - _cache_time) < CACHE_TTL:
        return ModelConfig(
            model=_cached_config.get("v2", {}).get("model", "gpt-4o"),
            reasoning_effort=_cached_config.get("v2", {}).get("reasoningEffort", "none")
        )
    
    settings = get_settings()
    core_api_url = settings.core_api_url
    internal_secret = settings.internal_agent_secret
    
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                f"{core_api_url}/super-admin/internal/model-config",
                headers={"X-Internal-Secret": internal_secret}
            )
            
            if response.status_code == 200:
                _cached_config = response.json()
                _cache_time = now
                
                return ModelConfig(
                    model=_cached_config.get("v2", {}).get("model", "gpt-4o"),
                    reasoning_effort=_cached_config.get("v2", {}).get("reasoningEffort", "none")
                )
    except Exception as e:
        logger.warning(f"Failed to fetch model config from Core API: {e}")
    
    return ModelConfig(model=settings.openai_model, reasoning_effort="none")


def estimate_tokens(text: str) -> int:
    """Rough token estimation (chars / 4)."""
    return len(text) // 4


def optimize_messages(
    messages: List[Dict[str, str]], 
    max_history_tokens: int = 3000
) -> List[Dict[str, str]]:
    """Truncate conversation history to fit within token limit."""
    if not messages:
        return messages
    
    system_messages = [m for m in messages if m.get("role") == "system"]
    conversation = [m for m in messages if m.get("role") != "system"]
    
    system_tokens = sum(estimate_tokens(m.get("content", "")) for m in system_messages)
    available = max(max_history_tokens - system_tokens, 500)
    
    optimized = []
    used_tokens = 0
    
    for msg in reversed(conversation):
        msg_tokens = estimate_tokens(msg.get("content", ""))
        if used_tokens + msg_tokens <= available:
            optimized.insert(0, msg)
            used_tokens += msg_tokens
        else:
            break
    
    return system_messages + optimized


async def call_openai(
    messages: List[Dict[str, str]],
    model: Optional[str] = None,
    reasoning_effort: ReasoningEffort = "none",
    max_tokens: int = 1000,
    temperature: float = 0.7,
    max_history_tokens: int = 3000
) -> OpenAIResult:
    """
    Unified OpenAI API wrapper.
    
    - GPT-5+, o1, o3 models -> Responses API (with optional reasoning)
    - GPT-4 and earlier -> Chat Completions API
    """
    settings = get_settings()
    
    if not model:
        config = await fetch_model_config()
        model = config.model
        if reasoning_effort == "none":
            reasoning_effort = config.reasoning_effort
    
    client = OpenAI(api_key=settings.openai_api_key)
    optimized = optimize_messages(messages, max_history_tokens)
    
    use_responses_api = is_gpt5_model(model)
    include_reasoning = use_responses_api and reasoning_effort != "none"
    
    content = ""
    tokens_used = 0
    
    if use_responses_api:
        response_params = {
            "model": model,
            "input": optimized,
            "max_output_tokens": max_tokens
        }
        
        if include_reasoning:
            reasoning_map = {
                "none": "low",
                "low": "low", 
                "medium": "medium",
                "high": "high",
                "xhigh": "high"
            }
            response_params["reasoning"] = {"effort": reasoning_map.get(reasoning_effort, "low")}
        
        try:
            response = client.responses.create(**response_params)
            
            for item in response.output or []:
                if getattr(item, "type", None) == "message":
                    for c in getattr(item, "content", []) or []:
                        if getattr(c, "type", None) == "output_text":
                            content = getattr(c, "text", "") or ""
                            break
                    break
            
            if response.usage:
                tokens_used = (response.usage.input_tokens or 0) + (response.usage.output_tokens or 0)
                
        except Exception as e:
            logger.error(f"Responses API error: {e}")
            raise
    else:
        try:
            completion = client.chat.completions.create(
                model=model,
                messages=optimized,
                max_tokens=max_tokens,
                temperature=temperature
            )
            
            content = completion.choices[0].message.content or ""
            
            if completion.usage:
                tokens_used = completion.usage.total_tokens
                
        except Exception as e:
            logger.error(f"Chat Completions API error: {e}")
            raise
    
    logger.info(f"OpenAI call: model={model}, reasoning={include_reasoning}, tokens={tokens_used}")
    
    return OpenAIResult(
        content=content,
        tokens_used=tokens_used,
        model=model,
        reasoning_used=include_reasoning
    )

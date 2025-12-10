import json
import redis
from typing import Optional, Dict, Any
from datetime import datetime
import logging

from ..config import get_settings

logger = logging.getLogger(__name__)

_redis_client: Optional[redis.Redis] = None

def get_redis_client() -> Optional[redis.Redis]:
    global _redis_client
    if _redis_client is None:
        settings = get_settings()
        if settings.redis_url:
            try:
                _redis_client = redis.from_url(settings.redis_url, decode_responses=True)
                _redis_client.ping()
                logger.info("Redis connected successfully")
            except Exception as e:
                logger.warning(f"Redis connection failed: {e}")
                _redis_client = None
    return _redis_client


def _memory_key(lead_id: str, business_id: str) -> str:
    return f"agent_v2:memory:{business_id}:{lead_id}"


def get_memory(lead_id: str, business_id: str) -> Dict[str, Any]:
    client = get_redis_client()
    
    default_memory = {
        "lead_id": lead_id,
        "business_id": business_id,
        "current_stage": None,
        "collected_data": {},
        "products_viewed": [],
        "followups_sent": [],
        "detected_preferences": [],
        "objections": [],
        "conversation_summary": None,
        "last_interaction": None,
        "interaction_count": 0,
        "created_at": datetime.utcnow().isoformat(),
        "updated_at": datetime.utcnow().isoformat()
    }
    
    if client is None:
        return default_memory
    
    try:
        key = _memory_key(lead_id, business_id)
        data = client.get(key)
        if data:
            memory = json.loads(data)
            for k, v in default_memory.items():
                if k not in memory:
                    memory[k] = v
            return memory
        return default_memory
    except Exception as e:
        logger.error(f"Error getting memory: {e}")
        return default_memory


def save_memory(lead_id: str, business_id: str, memory: Dict[str, Any]) -> bool:
    client = get_redis_client()
    
    if client is None:
        logger.warning("Redis not available, memory not saved")
        return False
    
    try:
        key = _memory_key(lead_id, business_id)
        memory["updated_at"] = datetime.utcnow().isoformat()
        client.set(key, json.dumps(memory), ex=60*60*24*30)
        return True
    except Exception as e:
        logger.error(f"Error saving memory: {e}")
        return False


def update_memory(lead_id: str, business_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
    memory = get_memory(lead_id, business_id)
    
    for key, value in updates.items():
        if key in memory:
            if isinstance(memory[key], list) and isinstance(value, list):
                for item in value:
                    if item not in memory[key]:
                        memory[key].append(item)
            elif isinstance(memory[key], dict) and isinstance(value, dict):
                memory[key].update(value)
            else:
                memory[key] = value
        else:
            memory[key] = value
    
    memory["interaction_count"] = memory.get("interaction_count", 0) + 1
    memory["last_interaction"] = datetime.utcnow().isoformat()
    
    save_memory(lead_id, business_id, memory)
    return memory


def add_product_viewed(lead_id: str, business_id: str, product_id: str) -> None:
    memory = get_memory(lead_id, business_id)
    if product_id not in memory.get("products_viewed", []):
        memory.setdefault("products_viewed", []).append(product_id)
        save_memory(lead_id, business_id, memory)


def add_preference(lead_id: str, business_id: str, preference: str) -> None:
    memory = get_memory(lead_id, business_id)
    if preference not in memory.get("detected_preferences", []):
        memory.setdefault("detected_preferences", []).append(preference)
        save_memory(lead_id, business_id, memory)


def add_objection(lead_id: str, business_id: str, objection: str) -> None:
    memory = get_memory(lead_id, business_id)
    if objection not in memory.get("objections", []):
        memory.setdefault("objections", []).append(objection)
        save_memory(lead_id, business_id, memory)


def set_stage(lead_id: str, business_id: str, stage: str) -> None:
    memory = get_memory(lead_id, business_id)
    memory["current_stage"] = stage
    save_memory(lead_id, business_id, memory)


def update_collected_data(lead_id: str, business_id: str, data: Dict[str, Any]) -> None:
    memory = get_memory(lead_id, business_id)
    memory.setdefault("collected_data", {}).update(data)
    save_memory(lead_id, business_id, memory)

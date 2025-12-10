from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any


class Product(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    price: Optional[float] = None
    currency: str = "USD"
    category: Optional[str] = None
    stock: Optional[int] = None
    image_url: Optional[str] = None
    attributes: Dict[str, Any] = Field(default_factory=dict)


class Policy(BaseModel):
    shipping: Optional[str] = None
    refund: Optional[str] = None
    brand_voice: Optional[str] = None
    custom_rules: List[str] = Field(default_factory=list)


class BusinessProfile(BaseModel):
    business_id: str
    business_name: str
    timezone: str = "America/Lima"
    currency_symbol: str = "S/."
    currency_code: str = "PEN"
    products: List[Product] = Field(default_factory=list)
    policies: Policy = Field(default_factory=Policy)
    custom_prompt: Optional[str] = None
    tools_enabled: bool = True
    tools_config: List[Dict[str, Any]] = Field(default_factory=list)
    dynamic_rules: List[str] = Field(default_factory=list)
    
    @classmethod
    def from_context(cls, context: Dict[str, Any]) -> "BusinessProfile":
        products = [
            Product(
                id=p.get("id", ""),
                name=p.get("name", p.get("title", "")),
                description=p.get("description"),
                price=p.get("price"),
                currency=p.get("currency", "USD"),
                category=p.get("category"),
                stock=p.get("stock"),
                image_url=p.get("image_url", p.get("imageUrl")),
                attributes=p.get("attributes", {})
            )
            for p in context.get("products", [])
        ]
        
        policies_list = context.get("policies", [])
        policy = Policy()
        for p in policies_list:
            if isinstance(p, str):
                if "envío" in p.lower() or "shipping" in p.lower():
                    policy.shipping = p
                elif "devolución" in p.lower() or "refund" in p.lower():
                    policy.refund = p
                elif "tono" in p.lower() or "voice" in p.lower():
                    policy.brand_voice = p
                else:
                    policy.custom_rules.append(p)
        
        return cls(
            business_id=context.get("business_id", ""),
            business_name=context.get("business_name", ""),
            timezone=context.get("timezone", "America/Lima"),
            products=products,
            policies=policy,
            custom_prompt=context.get("custom_prompt"),
            tools_enabled=context.get("tools_enabled", True),
            tools_config=context.get("tools_config", []),
            dynamic_rules=context.get("dynamic_rules", [])
        )

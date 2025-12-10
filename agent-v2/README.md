# Agent V2 Advanced - Multi-Agent AI System

Sistema multi-agente avanzado con LangGraph, Tools, Memoria Persistente y Aprendizaje Dinámico.

## Arquitectura

```
┌──────────────────────────────────────────────────────────────────┐
│                        Core API (Node.js)                        │
│                              │                                   │
│                      POST /generate                              │
│                              ▼                                   │
├──────────────────────────────────────────────────────────────────┤
│                    Agent V2 (Python/FastAPI)                     │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐          │
│  │   Memory    │    │  Embeddings │    │   Learning  │          │
│  │   (Redis)   │    │  (OpenAI)   │    │   (JSON)    │          │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘          │
│         │                  │                   │                 │
│         └──────────────────┼───────────────────┘                 │
│                            ▼                                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    LangGraph State Machine                 │  │
│  │                                                            │  │
│  │   ┌────────┐     ┌──────────┐     ┌──────────┐            │  │
│  │   │ Vendor │────▶│  Tools   │────▶│ Response │            │  │
│  │   │ Agent  │     │  Router  │     │ Builder  │            │  │
│  │   └────────┘     └──────────┘     └────┬─────┘            │  │
│  │        │                               │                   │  │
│  │        │         ┌────────────────────┘                   │  │
│  │        │         ▼                                        │  │
│  │        │    ┌──────────┐     ┌──────────┐                 │  │
│  │        └───▶│ Observer │────▶│ Refiner  │────▶ END        │  │
│  │             │  Agent   │     │  Agent   │                 │  │
│  │             └──────────┘     └──────────┘                 │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│                      JSON Response                               │
└──────────────────────────────────────────────────────────────────┘
```

## Los 3 Cerebros

### Cerebro 1: Vendor Agent
- Interpreta el mensaje del cliente
- Decide si responder directamente o usar una herramienta
- Consulta la memoria del lead para contexto
- Aplica las políticas del negocio
- Retorna JSON estructurado con acción

### Cerebro 2: Observer Agent
- Analiza la respuesta del Vendor
- Detecta fallas y errores
- Identifica objeciones del cliente
- Genera recomendaciones de mejora

### Cerebro 3: Refiner Agent
- Procesa insights del Observer
- Genera nuevas reglas de comportamiento
- Guarda aprendizajes en `/learning/ajustes_{business_id}.json`
- Mejora el sistema con cada interacción

## Tools Disponibles

| Tool | Descripción | Input |
|------|-------------|-------|
| `search_product` | Búsqueda semántica de productos | `query`, `max_results` |
| `payment` | Genera link de pago Stripe | `product_id`, `quantity`, `lead_id` |
| `followup` | Programa mensaje de seguimiento | `delay_minutes`, `message_type` |
| `media` | Obtiene URLs de imágenes/PDFs | `product_id`, `resource_name` |
| `crm` | Gestiona tags, etapas, intenciones | `action`, `tag_name`, `stage_name` |

## Estructura del Proyecto

```
agent-v2/
├── src/
│   ├── agents/
│   │   ├── vendor.py      # Cerebro 1
│   │   ├── observer.py    # Cerebro 2
│   │   ├── refiner.py     # Cerebro 3
│   │   └── sales_agent.py # (Legacy, mantener compatibilidad)
│   ├── tools/
│   │   ├── search_product.py
│   │   ├── payment.py
│   │   ├── followup.py
│   │   ├── media.py
│   │   └── crm.py
│   ├── core/
│   │   ├── graph.py       # LangGraph state machine
│   │   ├── memory.py      # Redis persistence
│   │   ├── embeddings.py  # Semantic search
│   │   └── tool_router.py # Tool execution
│   ├── schemas/
│   │   ├── business_profile.py
│   │   ├── vendor_state.py
│   │   └── tool_schemas.py
│   ├── learning/          # Dynamic rules por business
│   ├── main.py            # FastAPI endpoint
│   └── config.py          # Settings
├── requirements.txt
└── Dockerfile
```

## Variables de Entorno

| Variable | Descripción | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | API Key de OpenAI | (requerido) |
| `OPENAI_MODEL` | Modelo a usar | gpt-4o-mini |
| `REDIS_URL` | Redis para memoria persistente | (opcional) |
| `CORE_API_URL` | URL del Core API | http://localhost:3001 |
| `INTERNAL_AGENT_SECRET` | Secret para autenticación con Core API | internal-agent-secret-change-me |
| `PORT` | Puerto del servicio | 5001 |

## Endpoints

### GET /
Información del servicio y features disponibles.

### GET /health
Health check con lista de features activos.

### POST /generate
Genera respuesta de IA usando el sistema multi-agente.

**Request:**
```json
{
  "business_context": {
    "business_id": "...",
    "business_name": "...",
    "timezone": "America/Lima",
    "products": [...],
    "policies": [...],
    "custom_prompt": "..."
  },
  "conversation_history": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "current_message": "Hola, quiero comprar...",
  "sender_phone": "+51999999999",
  "sender_name": "Juan"
}
```

**Response:**
```json
{
  "success": true,
  "type": "message",
  "response": "¡Hola Juan! Con gusto te ayudo...",
  "tool": null,
  "tool_input": null,
  "tokens_used": 450,
  "model": "gpt-4o-mini",
  "observer_insights": {
    "fallas": [],
    "objeciones": [],
    "recomendaciones": []
  },
  "new_rules_learned": 0
}
```

## Desarrollo Local

```bash
cd agent-v2
pip install -r requirements.txt
python -m uvicorn src.main:app --host 0.0.0.0 --port 5001 --reload
```

## Docker

```bash
docker build -t agent-v2:latest .
docker run -p 5001:5001 \
  -e OPENAI_API_KEY=sk-... \
  -e REDIS_URL=redis://localhost:6379 \
  agent-v2:latest
```

## Configuración en Core API

```bash
AGENT_V2_URL=http://agent-v2:5001
```

## Aprendizaje Dinámico

El sistema aprende automáticamente de cada interacción:

1. **Observer** detecta problemas en las respuestas
2. **Refiner** genera reglas nuevas
3. Reglas se guardan en `/learning/ajustes_{business_id}.json`
4. En próximas conversaciones, el **Vendor** aplica estas reglas

Las reglas nunca se borran, solo se agregan. Esto crea un sistema que mejora continuamente.

## Compatibilidad

Este sistema es 100% compatible con el Agent V1 existente:
- Mismo formato de request/response
- Core API puede usar ambos según `business.agentVersion`
- No requiere cambios en el Core API

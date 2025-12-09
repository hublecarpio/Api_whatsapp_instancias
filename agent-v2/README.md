# Agent V2 - Advanced AI Agent Service

Servicio Python con FastAPI y LangGraph para procesamiento avanzado de IA.

## Arquitectura

```
Core API (Node.js) --HTTP--> Agent V2 (Python/FastAPI)
                                  |
                                  v
                            LangGraph Agent
                                  |
                                  v
                              OpenAI API
```

## Requisitos

- Python 3.11+
- OpenAI API Key

## Desarrollo Local (Replit)

```bash
cd agent-v2
pip install -r requirements.txt
python -m uvicorn src.main:app --host 0.0.0.0 --port 5001 --reload
```

## Docker Build & Push

```bash
cd agent-v2
docker build -t registry.digitalocean.com/huble/agent-v2:latest .
docker push registry.digitalocean.com/huble/agent-v2:latest
```

## Agregar al Docker Swarm

### Opcion 1: Desplegar como servicio separado

```bash
docker stack deploy -c agent-v2/docker-compose.yml efficore
```

### Opcion 2: Agregar al stack principal

Agregar este bloque al archivo `docker-stack-external-db.yml`:

```yaml
  agent-v2:
    image: registry.digitalocean.com/huble/agent-v2:latest
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - OPENAI_MODEL=${OPENAI_MODEL:-gpt-4o-mini}
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=redis://efficore_redis:6389
      - CORE_API_URL=http://core-api:4001
      - PORT=5001
    networks:
      - efficore_network
    deploy:
      replicas: 1
      restart_policy:
        condition: on-failure
```

## Variables de Entorno

| Variable | Descripcion | Default |
|----------|-------------|---------|
| OPENAI_API_KEY | API Key de OpenAI | (requerido) |
| OPENAI_MODEL | Modelo a usar | gpt-4o-mini |
| DATABASE_URL | PostgreSQL URL | (opcional) |
| REDIS_URL | Redis para memoria | (opcional) |
| CORE_API_URL | URL del Core API | http://localhost:3001 |
| PORT | Puerto del servicio | 5001 |

## Endpoints

- `GET /` - Info del servicio
- `GET /health` - Health check
- `POST /generate` - Generar respuesta de IA

## Configuracion en Core API

Agregar variable de entorno:

```bash
# Replit (desarrollo)
AGENT_V2_URL=http://localhost:5001

# Docker Swarm (produccion)
AGENT_V2_URL=http://agent-v2:5001
```

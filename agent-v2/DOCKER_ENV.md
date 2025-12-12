# Agent V2 - Environment Variables for Docker Swarm

## Required Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `OPENAI_API_KEY` | **YES** | OpenAI API key for AI responses | `sk-...` |
| `REDIS_URL` | Recommended | Redis URL for memory persistence | `redis://redis:6379` |
| `CORE_API_URL` | Recommended | Core API URL for model config | `http://core-api:3001` |
| `INTERNAL_AGENT_SECRET` | Recommended | Secret for internal auth | `your-secret-here` |
| `PORT` | Optional | Port to run on (default: 5001) | `5001` |

## Docker Swarm Service Example

```yaml
agent-v2:
  image: your-registry/agent-v2:latest
  environment:
    - OPENAI_API_KEY=${OPENAI_API_KEY}
    - REDIS_URL=redis://redis:6379
    - CORE_API_URL=http://core-api:3001
    - INTERNAL_AGENT_SECRET=${INTERNAL_AGENT_SECRET}
    - PORT=5001
  deploy:
    replicas: 2
    restart_policy:
      condition: on-failure
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:5001/health"]
    interval: 30s
    timeout: 10s
    retries: 3
  networks:
    - backend
```

## Health Check Response

The `/health` endpoint returns:

```json
{
  "status": "healthy|degraded|unhealthy",
  "version": "2.0.0",
  "model": "gpt-4o",
  "features": ["multi-agent", "langgraph", ...],
  "dependencies": {
    "openai_api_key": true,
    "redis": true,
    "core_api": true,
    "issues": [],
    "warnings": []
  }
}
```

Status meanings:
- `healthy`: All required dependencies available
- `degraded`: Some optional dependencies missing (e.g., Redis)
- `unhealthy`: Critical dependencies missing (e.g., OPENAI_API_KEY)

## Debugging in Production

1. Check health endpoint: `curl http://agent-v2:5001/health`
2. Check logs for `CONFIG ERROR` or `CONFIG WARNING` messages
3. Verify CORE_API_URL points to the correct internal Docker network address
4. Ensure REDIS_URL uses the Docker service name, not localhost

## Common Issues

### Agent not responding
- Check OPENAI_API_KEY is set and valid
- Check logs for `OpenAI API key not configured` error

### Memory not persisting
- Check REDIS_URL is set and Redis is accessible
- Look for `Redis connection failed` in logs

### Model config not updating
- Check CORE_API_URL points to Core API
- Verify INTERNAL_AGENT_SECRET matches Core API's secret
- Look for `Failed to fetch platform config` in logs

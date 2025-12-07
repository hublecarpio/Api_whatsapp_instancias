# WhatsApp SaaS Platform - Deployment Guide

## Services Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         EXTERNAL                                 │
│                    (Your Traefik/Nginx)                         │
│         You add labels to connect to your proxy                 │
└───────────────────────────┬─────────────────────────────────────┘
                            │
    ┌───────────────────────┼───────────────────────┐
    │                       │                       │
    ▼                       ▼                       ▼
┌─────────┐          ┌─────────────┐         ┌─────────────┐
│Frontend │ ──────▶  │  Core API   │ ──────▶ │WhatsApp API │
│ :3000   │          │   :3001     │         │   :8080     │
│(Next.js)│          │  (Express)  │         │  (Baileys)  │
└─────────┘          └──────┬──────┘         └──────┬──────┘
                            │                       │
                            ▼                       ▼
                     ┌────────────┐          ┌────────────┐
                     │ PostgreSQL │          │  Sessions  │
                     │   :5432    │          │  (Volume)  │
                     │ (internal) │          └────────────┘
                     └────────────┘
```

### 4 Services Total

| Service | Default Port | Configurable | Exposed | Description |
|---------|-------------|--------------|---------|-------------|
| **frontend** | 3000 | `FRONTEND_PORT` | Yes | Next.js UI - Put your domain here |
| **core-api** | 3001 | `CORE_API_PORT` | Yes | Business logic, auth, AI |
| **whatsapp-api** | 8080 | `WA_API_PORT` | Yes | Baileys multi-instance |
| **postgres** | 5432 | No | No | Database (internal only) |

### Internal Communication

- `frontend` → `core-api` via `http://core-api:${CORE_API_PORT}`
- `core-api` → `whatsapp-api` via `http://whatsapp-api:${WA_API_PORT}`
- `core-api` → `postgres` via `postgresql://...@postgres:5432/...`

### For Your Domain

Only expose **frontend** to the public. The other services communicate internally.

Example Traefik label for frontend:
```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.whatsapp-frontend.rule=Host(`app.yourdomain.com`)"
  - "traefik.http.services.whatsapp-frontend.loadbalancer.server.port=3000"
```

---

## Prerequisites

- **Docker 20.10+**
- **Docker Swarm initialized** (`docker swarm init`)
- **Private Docker registry** (or Docker Hub)

Verify Docker:
```bash
docker --version
docker swarm init  # if not already
```

## Quick Start

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd whatsapp-saas
```

### 2. Configure environment variables

```bash
cp .env.example .env
# Edit .env with your values
nano .env
```

### 3. Build Docker images

```bash
# Set your registry
export REGISTRY=your-registry.com
export TAG=latest
export DOMAIN=your-domain.com

# Build all images
./build-images.sh

# Build and push to registry
./build-images.sh --push
```

### 4. Create Traefik network (if not exists)

```bash
docker network create --driver=overlay --attachable traefik-public
```

### 5. Deploy to Swarm

```bash
# Load environment variables
source .env

# Deploy stack
docker stack deploy -c docker-stack.yml whatsapp-saas
```

### 6. Run database migrations

```bash
# Get the Core API container ID
docker ps | grep core-api

# Run migrations
docker exec -it <container-id> npx prisma db push
```

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `POSTGRES_PASSWORD` | Database password | `strong-password-123` |
| `SESSION_SECRET` | JWT secret (min 32 chars) | `your-secret-key-min-32-characters` |
| `DOMAIN` | Your domain for Traefik | `myapp.com` |

### Optional (with defaults)

| Variable | Description | Default |
|----------|-------------|---------|
| `POSTGRES_DB` | Database name | `whatsapp_saas` |
| `POSTGRES_USER` | Database user | `postgres` |
| `REGISTRY` | Docker registry | `localhost:5000` |
| `TAG` | Image tag | `latest` |

### MinIO / S3 Storage

| Variable | Description |
|----------|-------------|
| `MINIO_ENDPOINT` | MinIO/S3 endpoint URL |
| `MINIO_ACCESS_KEY` | Access key |
| `MINIO_SECRET_KEY` | Secret key |
| `MINIO_BUCKET` | Bucket name |
| `MINIO_PUBLIC_URL` | Public URL for media files |

## Services & Ports

| Service | Internal Port | External Route |
|---------|--------------|----------------|
| Frontend | 5000 | `https://{DOMAIN}` |
| Core API | 3001 | `https://api.{DOMAIN}` |
| WhatsApp API | 8080 | `https://wa.{DOMAIN}` |
| PostgreSQL | 5432 | Internal only |

## Architecture

```
                        ┌─────────────────┐
                        │    Traefik      │
                        │  (Load Balancer)│
                        └────────┬────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│   Frontend    │      │   Core API    │      │ WhatsApp API  │
│   (Next.js)   │─────▶│   (Express)   │◀────▶│   (Baileys)   │
│   Port 5000   │      │   Port 3001   │      │   Port 8080   │
└───────────────┘      └───────┬───────┘      └───────┬───────┘
                               │                      │
                               ▼                      ▼
                       ┌───────────────┐      ┌───────────────┐
                       │  PostgreSQL   │      │    Sessions   │
                       │    (Neon)     │      │   (Volume)    │
                       └───────────────┘      └───────────────┘
```

## Volumes

| Volume | Purpose | Mount Point |
|--------|---------|-------------|
| `postgres_data` | Database storage | `/var/lib/postgresql/data` |
| `whatsapp_sessions` | Baileys sessions | `/app/src/storage/sessions` |

## Useful Commands

```bash
# View stack status
docker stack services whatsapp-saas

# View logs
docker service logs whatsapp-saas_core-api -f
docker service logs whatsapp-saas_frontend -f
docker service logs whatsapp-saas_whatsapp-api -f

# Scale frontend
docker service scale whatsapp-saas_frontend=3

# Update a service
docker service update --image $REGISTRY/whatsapp-saas-frontend:$TAG whatsapp-saas_frontend

# Remove stack
docker stack rm whatsapp-saas
```

## Local Development

For local testing without Swarm:

```bash
docker-compose up -d
```

This will start all services on:
- Frontend: http://localhost:5000
- Core API: http://localhost:3001
- WhatsApp API: http://localhost:8080
- PostgreSQL: localhost:5432

## Troubleshooting

### Services not starting

```bash
# Check service status
docker service ps whatsapp-saas_core-api --no-trunc

# Check logs
docker service logs whatsapp-saas_core-api --tail 100
```

### Database connection issues

```bash
# Verify PostgreSQL is healthy
docker service ps whatsapp-saas_postgres

# Check Core API can reach database
docker exec -it $(docker ps -q -f name=core-api) node -e "console.log(process.env.DATABASE_URL)"
```

### WhatsApp sessions lost

Sessions are stored in the `whatsapp_sessions` volume. To backup:

```bash
docker run --rm -v whatsapp-saas_whatsapp_sessions:/data -v $(pwd):/backup alpine tar czf /backup/sessions-backup.tar.gz /data
```

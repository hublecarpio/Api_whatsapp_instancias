#!/bin/bash

# ============================================
# WhatsApp SaaS Platform - Docker Image Builder
# ============================================

set -e

# Load .env file if it exists
if [ -f .env ]; then
    echo "Loading variables from .env file..."
    export $(grep -v '^#' .env | xargs)
fi

# Check prerequisites
if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed or not in PATH"
    exit 1
fi

REGISTRY=${REGISTRY:-"docker.io/iamhuble"}
TAG=${TAG:-"latest"}
DOMAIN=${DOMAIN:-"localhost"}

echo "Building Docker images..."
echo "Registry: $REGISTRY"
echo "Tag: $TAG"
echo "Domain: $DOMAIN"

echo ""
echo "=== Building WhatsApp API ==="
docker build -t $REGISTRY/whatsapp-saas-wa:$TAG -f Dockerfile .

echo ""
echo "=== Building Core API ==="
docker build -t $REGISTRY/whatsapp-saas-core:$TAG -f core-api/Dockerfile ./core-api

echo ""
echo "=== Building Frontend ==="
docker build -t $REGISTRY/whatsapp-saas-frontend:$TAG \
  --build-arg NEXT_PUBLIC_API_URL=https://api.$DOMAIN \
  --build-arg CORE_API_URL=http://core-api:4001 \
  -f frontend/Dockerfile ./frontend

echo ""
echo "=== All images built successfully ==="
echo ""

if [ "$1" == "--push" ]; then
  echo "Pushing images to registry..."
  docker push $REGISTRY/whatsapp-saas-wa:$TAG
  docker push $REGISTRY/whatsapp-saas-core:$TAG
  docker push $REGISTRY/whatsapp-saas-frontend:$TAG
  echo "Images pushed successfully!"
fi

echo ""
echo "Images ready:"
echo "  - $REGISTRY/whatsapp-saas-wa:$TAG"
echo "  - $REGISTRY/whatsapp-saas-core:$TAG"
echo "  - $REGISTRY/whatsapp-saas-frontend:$TAG"

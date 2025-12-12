#!/bin/bash

set -e

REGISTRY="${REGISTRY:-docker.io/iamhuble}"
TAG="${TAG:-latest}"

echo "============================================"
echo "Building all Docker images"
echo "Registry: $REGISTRY"
echo "Tag: $TAG"
echo "============================================"

build_image() {
    local name=$1
    local dockerfile=$2
    local context=$3
    
    echo ""
    echo "----------------------------------------"
    echo "Building: $name"
    echo "----------------------------------------"
    
    docker build --no-cache -t "$REGISTRY/$name:$TAG" -f "$dockerfile" "$context"
    
    if [ $? -eq 0 ]; then
        echo "✅ $name built successfully"
    else
        echo "❌ $name build failed!"
        exit 1
    fi
}

echo ""
echo "1/4 - Building core-api..."
build_image "whatsapp-saas-core" "core-api/Dockerfile" "core-api"

echo ""
echo "2/4 - Building whatsapp-api..."
build_image "whatsapp-saas-wa" "Dockerfile" "."

echo ""
echo "3/4 - Building frontend..."
build_image "whatsapp-saas-frontend" "frontend/Dockerfile" "frontend"

echo ""
echo "4/4 - Building agent-v2..."
build_image "whatsapp-saas-agent-v2" "agent-v2/Dockerfile" "agent-v2"

echo ""
echo "============================================"
echo "All images built successfully!"
echo "============================================"
echo ""
echo "To push images to registry, run:"
echo "  docker push $REGISTRY/whatsapp-saas-core:$TAG"
echo "  docker push $REGISTRY/whatsapp-saas-wa:$TAG"
echo "  docker push $REGISTRY/whatsapp-saas-frontend:$TAG"
echo "  docker push $REGISTRY/whatsapp-saas-agent-v2:$TAG"
echo ""
echo "Or push all at once:"
echo "  docker push $REGISTRY/whatsapp-saas-core:$TAG && \\"
echo "  docker push $REGISTRY/whatsapp-saas-wa:$TAG && \\"
echo "  docker push $REGISTRY/whatsapp-saas-frontend:$TAG && \\"
echo "  docker push $REGISTRY/whatsapp-saas-agent-v2:$TAG"
echo ""

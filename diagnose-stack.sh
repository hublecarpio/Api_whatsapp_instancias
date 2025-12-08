#!/bin/bash

# ============================================
# WhatsApp SaaS - Stack Diagnostics
# ============================================
# Run this script to diagnose deployment issues

echo "============================================"
echo "WhatsApp SaaS - Stack Diagnostics"
echo "============================================"
echo ""

STACK_NAME=${1:-"whatsapp"}

echo "1. STACK SERVICES STATUS"
echo "----------------------------------------"
docker stack services $STACK_NAME 2>/dev/null || echo "Stack '$STACK_NAME' not found. Usage: ./diagnose-stack.sh <stack-name>"
echo ""

echo "2. CONTAINER STATUS (all replicas)"
echo "----------------------------------------"
docker stack ps $STACK_NAME --no-trunc 2>/dev/null | head -20
echo ""

echo "3. CHECKING EACH SERVICE..."
echo "----------------------------------------"

for service in core-api whatsapp-api frontend; do
  echo ""
  echo "=== ${STACK_NAME}_${service} ==="
  
  container_id=$(docker ps -q -f "name=${STACK_NAME}_${service}" | head -1)
  
  if [ -z "$container_id" ]; then
    echo "  Status: NOT RUNNING"
    echo "  Recent logs from failed attempts:"
    docker service logs ${STACK_NAME}_${service} --tail 20 2>/dev/null || echo "  No logs available"
  else
    echo "  Status: RUNNING (container: $container_id)"
    echo "  Health: $(docker inspect --format='{{.State.Health.Status}}' $container_id 2>/dev/null || echo 'no healthcheck')"
    echo "  Recent logs:"
    docker logs $container_id --tail 10 2>/dev/null
  fi
done

echo ""
echo "4. NETWORK CONNECTIVITY"
echo "----------------------------------------"
echo "Networks:"
docker network ls | grep -E "(whatsapp|traefik)"
echo ""

echo "5. VOLUMES"
echo "----------------------------------------"
docker volume ls | grep whatsapp
echo ""

echo "6. QUICK HEALTH CHECK URLS"
echo "----------------------------------------"
echo "If services are running, test these internally:"
echo "  docker exec <core-api-container> wget -qO- http://localhost:4001/"
echo "  docker exec <wa-api-container> wget -qO- http://localhost:4080/"
echo "  docker exec <frontend-container> wget -qO- http://localhost:4000/"
echo ""

echo "============================================"
echo "Diagnostics complete!"
echo "============================================"

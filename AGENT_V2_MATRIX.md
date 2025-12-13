# Matriz de Funcionamiento - Agente V2 (EfficoreChat)

> **v2.0 - FROZEN DESIGN**  
> Fecha: 13 de Diciembre 2025  
> Este documento representa el diseño congelado del Agente V2.  
> **REGLA: Ninguna lógica nueva sin reflejo explícito en `schemas/` y `core/graph.py`**

---

## Resumen Ejecutivo

El Agente V2 es un sistema multi-agente avanzado que utiliza LangGraph para procesar mensajes de WhatsApp de forma inteligente. A diferencia del Agente V1 (respuesta directa con OpenAI), el V2 implementa un sistema de **3 cerebros** que trabajan en conjunto para:

1. Responder de forma precisa
2. Auto-analizar sus respuestas
3. Aprender y mejorar continuamente

---

## Arquitectura de 3 Cerebros

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          MENSAJE DEL CLIENTE                            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         CEREBRO 1: VENDOR AGENT                         │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐               │
│  │   Interpretar │  │   Consultar   │  │   Decidir     │               │
│  │   Mensaje     │──│   Memoria     │──│   Acción      │               │
│  └───────────────┘  └───────────────┘  └───────────────┘               │
│                                                                          │
│  Acciones posibles:                                                      │
│  • Responder directamente                                                │
│  • Usar una herramienta (tool)                                          │
│  • Consultar base de conocimiento                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        CEREBRO 2: OBSERVER AGENT                        │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐               │
│  │   Analizar    │  │   Detectar    │  │   Generar     │               │
│  │   Respuesta   │──│   Fallas      │──│   Feedback    │               │
│  └───────────────┘  └───────────────┘  └───────────────┘               │
│                                                                          │
│  Detecta:                                                                │
│  • Fallas en la respuesta del Vendor                                    │
│  • Objeciones del cliente no manejadas                                  │
│  • Oportunidades de mejora                                              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        CEREBRO 3: REFINER AGENT                         │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐               │
│  │   Procesar    │  │   Generar     │  │   Guardar     │               │
│  │   Feedback    │──│   Reglas      │──│   en Redis    │               │
│  └───────────────┘  └───────────────┘  └───────────────┘               │
│                                                                          │
│  Genera:                                                                 │
│  • Nuevas reglas de comportamiento                                      │
│  • Respuestas sugeridas para situaciones comunes                        │
│  • Aprendizaje persistente por negocio                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        RESPUESTA AL CLIENTE                             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Detalle de Cada Cerebro

### Cerebro 1: Vendor Agent (Agente de Ventas)

**Rol:** Agente principal que interactúa con el cliente.

**Responsabilidades:**
- Interpretar el mensaje del cliente
- Consultar la memoria del lead para contexto
- Decidir si responder directamente o usar una herramienta
- Aplicar las políticas del negocio
- Aplicar reglas dinámicas aprendidas

**Formato de Respuesta (JSON):**
```json
{
  "accion": "respuesta" | "tool",
  "mensaje": "mensaje al cliente (si accion es respuesta)",
  "nombre_tool": "search_product" | "payment" | "followup" | "media" | "crm" | "search_knowledge" | null,
  "input_tool": { ... }
}
```

**Información que Recibe:**
- Fecha/hora actual (con timezone del negocio)
- Prompt personalizado del negocio
- Lista de productos (hasta 15 inline, resto vía búsqueda)
- Políticas (envíos, devoluciones, tono de voz)
- Memoria del lead (nombre, preferencias, historial)
- Reglas dinámicas aprendidas
- Contexto de base de conocimiento (si aplica)
- Feedback del Observer (en caso de corrección)

---

### Cerebro 2: Observer Agent (Agente Observador)

**Rol:** Analista de calidad que evalúa cada interacción.

**Responsabilidades:**
- Analizar la respuesta del Vendor
- Detectar fallas y errores
- Identificar objeciones no manejadas
- Generar recomendaciones de mejora

**Formato de Salida:**
```json
{
  "fallas": ["lista de errores en la respuesta"],
  "objeciones": ["objeciones del cliente no manejadas"],
  "recomendaciones": ["sugerencias de mejora"]
}
```

**Ejemplos de Fallas que Detecta:**
- "No mencionó el precio cuando el cliente lo preguntó"
- "No ofreció alternativas cuando el producto estaba agotado"
- "Respuesta demasiado larga y confusa"
- "No detectó la intención de compra del cliente"

**Ejemplos de Objeciones:**
- "Cliente mencionó que el precio es alto"
- "Cliente tiene dudas sobre el tiempo de envío"
- "Cliente quiere comparar con otras opciones"

---

### Cerebro 3: Refiner Agent (Agente Refinador)

**Rol:** Motor de aprendizaje continuo.

**Responsabilidades:**
- Procesar insights del Observer
- Generar nuevas reglas de comportamiento
- Crear respuestas sugeridas para situaciones comunes
- Persistir el aprendizaje en Redis

**Formato de Salida:**
```json
{
  "nuevas_reglas": ["regla 1", "regla 2"],
  "nuevas_respuestas": [
    {
      "situacion": "descripción de la situación",
      "respuesta_sugerida": "texto de respuesta"
    }
  ]
}
```

**Ejemplos de Reglas Generadas:**
- "Siempre mencionar formas de pago cuando se hable de precios"
- "Si el cliente dice 'es caro', ofrecer descuento o plan de pagos"
- "Ante preguntas de disponibilidad, verificar stock antes de responder"
- "Si el cliente no responde en 2 mensajes, usar followup"

**Persistencia:**
- Las reglas se guardan en Redis con clave: `agent_v2:learning:{business_id}`
- Las reglas persisten entre reinicio
- Se cargan automáticamente en cada conversación

---

## Herramientas Disponibles (Skills)

### 1. search_product
**Propósito:** Buscar productos en el catálogo
**Cuándo usar:** Cuando el cliente pregunta por un producto específico o quiere ver opciones
**Input:**
```json
{
  "query": "término de búsqueda",
  "limit": 5
}
```
**Output:** Lista de productos coincidentes con precio, stock, descripción

---

### 2. search_knowledge
**Propósito:** Buscar en la base de conocimiento del negocio
**Cuándo usar:** Cuando el cliente pregunta algo que podría estar en documentación
**Input:**
```json
{
  "query": "pregunta del cliente"
}
```
**Output:** Información relevante de los documentos cargados

---

### 3. payment
**Propósito:** Generar link de pago
**Cuándo usar:** Cuando el cliente confirma que quiere comprar
**Input:**
```json
{
  "product_ids": ["id1", "id2"],
  "quantities": [1, 2]
}
```
**Output:** URL de pago de Stripe

---

### 4. followup
**Propósito:** Programar seguimiento automático
**Cuándo usar:** Cuando el cliente necesita tiempo para decidir
**Input:**
```json
{
  "delay_minutes": 30,
  "message_template": "custom" | null
}
```
**Output:** Confirmación de programación

---

### 5. media
**Propósito:** Enviar imagen de producto al cliente
**Cuándo usar:** Cuando el cliente quiere ver el producto
**Input:**
```json
{
  "product_id": "id del producto",
  "type": "image" | "document"
}
```
**Output:** Imagen enviada al WhatsApp del cliente

---

### 6. crm
**Propósito:** Actualizar datos del lead en el CRM
**Cuándo usar:** Para clasificar leads, cambiar etapas, agregar tags
**Input:**
```json
{
  "action": "update_stage" | "add_tag" | "update_intent",
  "value": "valor correspondiente"
}
```
**Output:** Confirmación de actualización

---

### 7. custom_tool (Tools Personalizados)
**Propósito:** Ejecutar endpoints externos configurados por el usuario
**Cuándo usar:** Según la configuración del negocio
**Input:** Variables dinámicas definidas en la configuración
**Output:** Respuesta del endpoint externo

---

## Sistema de Memoria

### Memoria por Lead
Cada lead tiene memoria persistente que incluye:

```json
{
  "phone": "número del lead",
  "name": "nombre detectado",
  "stage": "etapa actual (nuevo, interesado, caliente, etc.)",
  "preferences": ["preferencias detectadas"],
  "collected_data": {
    "campo1": "valor1",
    "campo2": "valor2"
  },
  "notes": ["notas del agente"],
  "last_interaction": "timestamp"
}
```

### Persistencia
- **Storage:** Redis
- **Clave:** `agent_v2:memory:{lead_id}:{business_id}`
- **TTL:** Configurable (default: 30 días)

### Actualización
- La memoria se actualiza después de cada interacción
- El agente puede extraer datos automáticamente de la conversación
- Los datos se usan para personalizar respuestas futuras

---

## Configuración para Producción

### Variables de Entorno Requeridas

```env
# OpenAI (Obligatorio)
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini  # o gpt-4o para mejor calidad

# Redis (Obligatorio para memoria y aprendizaje)
REDIS_URL=redis://host:port

# Core API (Obligatorio)
CORE_API_URL=http://core-api:4001

# Configuración de modelos por cerebro (Opcional)
VENDOR_MODEL=gpt-4o-mini    # Cerebro 1
OBSERVER_MODEL=gpt-4o-mini  # Cerebro 2
REFINER_MODEL=gpt-4o-mini   # Cerebro 3

# Workers
WORKERS=4
PORT=5001
```

### Docker Swarm

En tu `docker-stack.yml`:
```yaml
agent-v2:
  image: docker.io/iamhuble/whatsapp-saas-agent-v2:latest
  environment:
    - OPENAI_API_KEY=sk-...
    - OPENAI_MODEL=gpt-4o-mini
    - DATABASE_URL=postgresql://...
    - REDIS_URL=redis://efficore_redis:6389
    - CORE_API_URL=http://core-api:4001
    - INTERNAL_AGENT_SECRET=tu_secreto
    - PORT=5001
    - WORKERS=4
  deploy:
    replicas: 2
    resources:
      limits:
        memory: 1024M
```

### Replicas Recomendadas
- **Desarrollo:** 1 replica
- **Producción pequeña (<100 usuarios):** 2 replicas
- **Producción media (100-1000 usuarios):** 4 replicas
- **Producción grande (>1000 usuarios):** 6+ replicas + Redis cluster

---

## Configuración desde el Dashboard

### 1. Activar Agente V2
1. Ir a **Agente IA**
2. En "Versión del Agente", hacer clic en **V2 Avanzado**
3. Requiere plan Pro

### 2. Configurar Skills
En la pestaña **Skills V2**:
- **search_product:** Búsqueda de productos (activado por defecto)
- **payment:** Generación de pagos (activado por defecto)
- **followup:** Seguimientos automáticos (activado por defecto)
- **media:** Envío de multimedia (activado por defecto)
- **crm:** Actualización de CRM (activado por defecto)

### 3. Configurar Prompts de los 3 Cerebros
En la pestaña **3 Cerebros**:
- **Vendor:** Personalidad y comportamiento del vendedor
- **Observer:** Criterios de análisis
- **Refiner:** Estilo de las reglas generadas

### 4. Ver Memoria de Leads
En la pestaña **Memoria**:
- Ver datos recopilados por lead
- Limpiar memoria de leads específicos

### 5. Gestionar Reglas Aprendidas
En la pestaña **Reglas**:
- Ver todas las reglas generadas automáticamente
- Activar/desactivar reglas específicas
- Eliminar reglas incorrectas

---

## Flujo Completo de una Conversación

```
1. Cliente envía mensaje por WhatsApp
                    │
2. WhatsApp API recibe y envía a Core API
                    │
3. Core API detecta que el negocio usa V2
                    │
4. Core API llama a Agent V2 (/generate)
                    │
5. Agent V2:
   a. Carga memoria del lead
   b. Carga reglas dinámicas
   c. Busca en base de conocimiento si es relevante
   d. Ejecuta Vendor Agent
      │
      ├── Si respuesta directa → genera mensaje
      └── Si necesita tool → ejecuta tool
                    │
6. Observer Agent analiza la respuesta
                    │
7. Refiner Agent genera nuevas reglas (si hay feedback)
                    │
8. Actualiza memoria del lead
                    │
9. Retorna respuesta a Core API
                    │
10. Core API envía mensaje por WhatsApp API
                    │
11. Cliente recibe respuesta
```

---

## Mejores Prácticas para Producción

### 1. Prompt del Vendor
- Ser específico sobre el tono de voz
- Incluir instrucciones claras sobre productos
- Definir qué hacer en casos edge (sin stock, preguntas fuera de contexto)

### 2. Base de Conocimiento
- Subir documentos con FAQs, políticas, información técnica
- Actualizar regularmente
- El agente usará esto automáticamente

### 3. Reglas Dinámicas
- Revisar semanalmente las reglas generadas
- Desactivar reglas que generen comportamientos no deseados
- El sistema aprende mejor con más conversaciones

### 4. Monitoreo
- Revisar logs del Observer para detectar problemas recurrentes
- Ajustar prompts basándote en las fallas detectadas

### 5. Escalabilidad
- Usar Redis cluster para alta disponibilidad
- Aumentar replicas gradualmente según carga
- Monitorear uso de tokens de OpenAI

---

## Comparación V1 vs V2

| Característica | V1 | V2 |
|---------------|----|----|
| Cerebros | 1 | 3 |
| Aprendizaje | No | Sí (dinámico) |
| Memoria | Básica | Avanzada por lead |
| Auto-corrección | No | Sí (Observer) |
| Base de conocimiento | No | Sí (embeddings) |
| Tools personalizados | Sí | Sí + más internos |
| Costo tokens | Menor | Mayor (3 LLM calls) |
| Latencia | ~2-3s | ~4-6s |
| Requiere Redis | No | Sí |
| Plan requerido | Cualquiera | Pro |

---

## Troubleshooting

### "Agent V2 no responde"
1. Verificar que OPENAI_API_KEY esté configurado
2. Verificar que Redis esté disponible
3. Revisar logs: `docker service logs saas_agent-v2`

### "Respuestas genéricas"
1. Mejorar el prompt del Vendor
2. Subir documentos a la base de conocimiento
3. Revisar y activar reglas útiles

### "Aprendizaje no funciona"
1. Verificar conexión a Redis
2. Revisar que el Observer esté analizando (ver logs)
3. Verificar que el Refiner esté generando reglas

### "Alto consumo de tokens"
1. Reducir historyLimit en configuración
2. Limitar productos inline (actualmente 15)
3. Considerar usar modelos más pequeños para Observer/Refiner

---

## API Endpoints

### Health Check
```
GET /health
```
Retorna estado de dependencias (Redis, Core API, OpenAI).

### Generate Response
```
POST /generate
Body: {
  "business_context": { ... },
  "conversation_history": [ ... ],
  "current_message": "texto",
  "sender_phone": "+51...",
  "sender_name": "nombre"
}
```

### Memory Management
```
GET /memory/{lead_id}/{business_id}
DELETE /memory/{lead_id}/{business_id}
GET /memory/stats/{business_id}
```

---

## Escenarios de Validación (FASE 8)

Esta sección documenta los escenarios de prueba para validar que el sistema gobernado por estado funciona correctamente.

### Escenario 1: Bloqueo de Payment Sin Productos Confirmados

**Objetivo**: Verificar que el grafo NO permite generar payment links si no hay productos confirmados.

**Precondiciones**:
- `commercial_state.productos_confirmados = []`
- `commercial_state.total_calculado = null`

**Input del Usuario**: "Quiero pagar"

**Comportamiento Esperado**:
1. Vendor interpreta intención como `INTENCION_COMPRA`
2. Vendor sugiere tool `payment`
3. `CommercialState.can_execute_tool("payment")` retorna `(False, "No hay productos confirmados")`
4. Grafo cambia decisión a `response_only`
5. Respuesta final: mensaje pidiendo que primero confirme productos

**Validación**:
```python
assert graph_decision == "response_only"
assert "payment" not in executed_tools
```

---

### Escenario 2: Transición de Etapa Comercial

**Objetivo**: Verificar transiciones correctas de etapa según la intención detectada.

**Matriz de Transiciones**:
| Etapa Actual | Intención | Nueva Etapa |
|--------------|-----------|-------------|
| NUEVO | CONSULTA_PRODUCTO | EXPLORANDO |
| EXPLORANDO | INTENCION_COMPRA | INTERESADO |
| INTERESADO | CONFIRMACION_COMPRA (con productos) | CONFIRMANDO |
| CONFIRMANDO | payment ejecutado exitoso | PAGANDO |

**Validación**:
```python
assert commercial_state.etapa_comercial == expected_etapa
```

---

### Escenario 3: Observer Como Guardián

**Objetivo**: Verificar que el Observer bloquea estados inválidos.

**Caso 3.1 - Intención vs Etapa Incoherente**:
- Etapa: NUEVO
- Intención sugerida: CONFIRMACION_COMPRA
- **Esperado**: `estado_valido = False`, error: "Etapa no corresponde a confirmación"

**Caso 3.2 - Productos Detectados vs Confirmados**:
- `productos_confirmados = [producto_A]`
- `productos_detectados = []`
- **Esperado**: `estado_valido = False`, error: "Productos confirmados no existen en detectados"

**Validación**:
```python
assert observer_validation.estado_valido == False
assert len(observer_validation.errores) > 0
```

---

### Escenario 4: Reglas Pendientes vs Activas

**Objetivo**: Verificar que las nuevas reglas van a pendientes, no se aplican automáticamente.

**Flujo**:
1. Observer detecta falla recurrente
2. Refiner propone nueva regla via `propose_rules()`
3. Regla se guarda en `reglas_pendientes`
4. Admin aprueba via `approve_rule(rule_id)`
5. Regla se mueve a `reglas_activas`

**Validación**:
```python
# Después de propose_rules
assert new_rule in redis.get(f"agent_v2:rules_pending:{business_id}")
assert new_rule not in redis.get(f"agent_v2:rules:{business_id}")

# Después de approve_rule
assert new_rule not in redis.get(f"agent_v2:rules_pending:{business_id}")
assert new_rule in redis.get(f"agent_v2:rules:{business_id}")
```

---

### Escenario 5: Tools Como Infraestructura Pura

**Objetivo**: Verificar que las tools no contienen lógica de negocio.

**Checklist**:
- [ ] `search_product.py`: Solo recibe query, retorna productos
- [ ] `send_media.py`: Solo recibe file_id, envía archivo
- [ ] `payment.py`: Solo recibe datos validados, genera link
- [ ] `crm_update.py`: Solo recibe campos, actualiza contacto

**Anti-Patrón** (NO debe existir en tools):
```python
# MAL - Lógica de negocio en tool
if etapa_comercial != "confirmando":
    return {"error": "No puedes pagar"}
```

**Patrón Correcto** (validación en grafo):
```python
# BIEN - Tool solo ejecuta
async def execute(self, input_data):
    return await self.payment_service.create_link(input_data)
```

---

### Escenario 6: Flujo Completo de Venta

**Objetivo**: Validar el happy path completo.

**Pasos**:
1. **Cliente**: "Hola, qué tienen?" → Etapa: NUEVO → EXPLORANDO
2. **Cliente**: "Me interesa el producto X" → Etapa: EXPLORANDO → INTERESADO
3. **Cliente**: "Cuánto cuesta?" → Tool: search_product ejecutada
4. **Cliente**: "Quiero 2 unidades" → productos_detectados += [X:2]
5. **Cliente**: "Sí, confirmo el pedido" → productos_confirmados = productos_detectados
6. **Cliente**: "Cómo pago?" → Tool: payment ejecutada (estado válido)
7. Etapa final: PAGANDO

**Validación**:
```python
assert final_etapa == EtapaComercial.PAGANDO
assert len(tool_calls) == 2  # search_product + payment
assert payment_link is not None
```

---

### Escenario 7: Recuperación de Errores

**Objetivo**: Verificar manejo de errores recuperables.

**Caso**: Tool `payment` falla por timeout de Stripe

**Comportamiento Esperado**:
1. `tool_success = False`, `tool_error = "Stripe timeout"`
2. Grafo NO avanza etapa a PAGANDO
3. `EstadoError` agregado con `recoverable = True`
4. Vendor genera respuesta de reintento

**Validación**:
```python
assert commercial_state.etapa_comercial != EtapaComercial.PAGANDO
assert any(e.recoverable for e in commercial_state.errores_estado)
```

---

### Comandos de Prueba

```bash
# Ejecutar tests unitarios (cuando se implementen)
cd agent-v2 && pytest tests/

# Test manual via curl
curl -X POST http://localhost:5005/generate \
  -H "Content-Type: application/json" \
  -d '{
    "business_context": {...},
    "conversation_history": [],
    "current_message": "Quiero pagar",
    "sender_phone": "+51999999999"
  }'

# Verificar logs de decisión del grafo
docker service logs saas_agent-v2 2>&1 | grep "graph_decision"
```

---

## Conclusión

El Agente V2 representa un salto significativo en capacidades de IA conversacional para ventas. Su arquitectura de 3 cerebros permite:

1. **Respuestas más precisas** gracias a la memoria contextual
2. **Mejora continua** mediante el aprendizaje dinámico
3. **Detección proactiva de problemas** con el Observer
4. **Integración profunda** con el CRM y base de conocimiento

Para negocios en producción, se recomienda:
- Empezar con configuración básica
- Monitorear las reglas generadas la primera semana
- Ajustar prompts según feedback del Observer
- Escalar replicas gradualmente

El sistema está diseñado para mejorar automáticamente con cada conversación, reduciendo la intervención manual necesaria con el tiempo.

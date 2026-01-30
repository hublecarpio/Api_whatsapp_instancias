import { BaseTool, ToolCategory, ToolDefinition, ToolContext, ToolResult, ToolAvailabilityContext, ToolDefinitionContext, toolRegistry } from '../core/index.js';
import { LLMFactory } from '../core/llmAdapter.js';
import { loadBusinessContext, loadConversationContext } from '../prompts/contextBuilder.js';
import { loadCustomToolsForBusiness } from './customToolAdapter.js';

// Debug flag for verbose logging
const DEBUG_AGENT = process.env.DEBUG_AGENT_V3 === 'true';

// Helper to redact PII from log outputs
function redactForLog(obj: any, maxLen: number = 150): string {
  if (!obj) return 'null';
  let str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  str = str.replace(/\b\d{9,15}\b/g, '***PHONE***');
  str = str.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '***EMAIL***');
  str = str.replace(/([a-f0-9]{8})-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '$1...');
  if (str.length > maxLen) str = str.substring(0, maxLen) + '...';
  return str;
}

interface ToolMemory {
  productData: Array<{
    productId: string;
    title: string;
    variation?: string;
    price: number;
    stock?: number;
    imageUrl?: string;
  }>;
  calculatedTotals: {
    subtotal?: number;
    shipping?: number;
    total?: number;
    zone?: string;
    zoneId?: string;
  };
  orderId?: string;
  orderStatus?: string;
  toolHistory: Array<{
    name: string;
    success: boolean;
    iteration: number;
  }>;
}

export class DelegateToolExecutionTool extends BaseTool {
  readonly name = 'ejecutar_accion';
  readonly category: ToolCategory = 'CUSTOM';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    const toolDescriptions = this.getSubToolDescriptions(context);
    
    return {
      name: this.name,
      description: `OBLIGATORIO: Usa esta herramienta para TODAS las acciones que requieran datos del catálogo, cálculos de precios, o gestión de pedidos.

CUÁNDO USAR:
- Cliente pregunta por un producto → usa para buscar y obtener precio exacto
- Cliente confirma producto/variación/zona → usa para calcular total
- Cliente quiere hacer un pedido → usa para crear/modificar orden
- Cualquier consulta de stock, disponibilidad, o catálogo

SUB-HERRAMIENTAS DISPONIBLES:
${toolDescriptions}

FLUJO TÍPICO DE VENTA:
1. Cliente menciona producto → buscar_producto para obtener ID y precio
2. Cliente confirma variación → buscar_producto con variación específica
3. Cliente da zona de envío → calcular_total_pedido con productos y zona
4. Cliente confirma pedido → confirmar_pedido con todos los datos

IMPORTANTE: Esta herramienta mantiene memoria de productos encontrados y cálculos realizados entre iteraciones para completar la tarea.`,
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          objetivo: {
            type: 'string',
            description: 'Qué necesitas lograr. Ej: "buscar precio de Erba Pura 100ml", "calcular total con envío a Lima", "crear orden de 2 perfumes"'
          },
          contexto_adicional: {
            type: 'string',
            description: 'Información adicional del cliente: nombre, dirección, productos ya mencionados, etc.'
          }
        },
        required: ['objetivo']
      }
    };
  }

  private getSubToolDescriptions(context: ToolDefinitionContext): string {
    const tools = [
      {
        name: 'buscar_producto',
        available: context.hasProducts,
        description: 'Busca productos por nombre/descripción',
        payload: '{ busqueda: "nombre producto", limite: 5 }',
        returns: 'Lista con: título, variación, precio, stock'
      },
      {
        name: 'consultar_stock',
        available: context.hasProducts,
        description: 'Consulta stock de producto específico',
        payload: '{ producto: "nombre exacto" }',
        returns: 'Cantidad disponible'
      },
      {
        name: 'calcular_total_pedido',
        available: context.hasProducts && context.hasZones,
        description: 'OBLIGATORIO antes de dar precio total',
        payload: '{ productos: [{nombre:"X", cantidad:1}], zona_envio: "Lima" }',
        returns: 'Subtotal + envío = TOTAL EXACTO'
      },
      {
        name: 'confirmar_pedido',
        available: context.hasProducts,
        description: 'Crea/confirma una orden',
        payload: '{ productos, direccion, metodoPago, zona }',
        returns: 'ID de orden y resumen'
      },
      {
        name: 'agregar_producto_orden',
        available: context.hasActiveOrder,
        description: 'Agrega producto a orden existente (usa productId UUID y variation exacta)',
        payload: '{ productId: "UUID", variation: "100 ml", quantity: 1 }',
        returns: 'Nuevo total de orden'
      },
      {
        name: 'consultar_pedido',
        available: context.hasActiveOrder,
        description: 'Consulta estado de orden activa',
        payload: '{}',
        returns: 'Detalles completos de la orden'
      }
    ];

    if (context.hasAppointments) {
      tools.push({
        name: 'agendar_cita',
        available: true,
        description: 'Agenda una cita/servicio',
        payload: '{ fecha, hora, servicio, notas }',
        returns: 'Confirmación de cita'
      });
      tools.push({
        name: 'consultar_disponibilidad',
        available: true,
        description: 'Verifica horarios disponibles',
        payload: '{ fecha, servicio }',
        returns: 'Horarios libres'
      });
    }

    return tools
      .filter(t => t.available)
      .map(t => `• ${t.name}: ${t.description}\n  Payload: ${t.payload}\n  Retorna: ${t.returns}`)
      .join('\n\n');
  }

  isAvailable(context: ToolAvailabilityContext): boolean {
    return context.hasProducts || context.hasAppointments;
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const phoneMask = context.contactPhone?.length > 4 ? `***${context.contactPhone.slice(-4)}` : '****';
    
    console.log(`[LLM2-Delegate] ═══════════════════════════════════════════════════════`);
    console.log(`[LLM2-Delegate] ▶ STARTING ejecutar_accion`);
    console.log(`[LLM2-Delegate] Phone: ${phoneMask}, Business: ${context.businessId?.slice(0, 8)}...`);
    console.log(`[LLM2-Delegate] Objetivo: "${args.objetivo?.substring(0, 100)}..."`);
    console.log(`[LLM2-Delegate] Contexto adicional: "${args.contexto_adicional?.substring(0, 50) || 'none'}"`);
    console.log(`[LLM2-Delegate] ═══════════════════════════════════════════════════════`);

    const { businessId, instanceId, contactPhone, contactName, conversationMessages } = context;
    const objetivo = args.objetivo;
    const contextoAdicional = args.contexto_adicional || '';
    const maxIterations = 5;

    if (!objetivo) {
      console.log(`[LLM2-Delegate] ✗ ERROR: No objetivo specified`);
      return this.error('Debes especificar el objetivo de la acción.');
    }

    try {
      await loadCustomToolsForBusiness(businessId);

      const businessContext = await loadBusinessContext(businessId, instanceId);
      const convContext = await loadConversationContext(businessId, contactPhone, instanceId);
      
      console.log(`[LLM2-Delegate] Context loaded: products=${businessContext.products.length}, zones=${businessContext.deliveryZones.length}`);
      console.log(`[LLM2-Delegate] Existing order: ${convContext.existingOrder?.id?.slice(0, 8) || 'NONE'}`);

      const availabilityContext: ToolAvailabilityContext = {
        businessId,
        instanceId,
        hasActiveOrder: !!convContext.existingOrder,
        hasProducts: businessContext.products.length > 0,
        hasZones: businessContext.deliveryZones.length > 0,
        hasAppointments: businessContext.hasAppointments,
        businessObjective: businessContext.businessObjective
      };

      const definitionContext: ToolDefinitionContext = {
        hasActiveOrder: !!convContext.existingOrder,
        hasProducts: businessContext.products.length > 0,
        hasZones: businessContext.deliveryZones.length > 0,
        hasAppointments: businessContext.hasAppointments,
        zoneDescriptions: businessContext.deliveryZones.map((z: any) => `${z.name} (S/${z.cost})`).join(', '),
        businessObjective: businessContext.businessObjective
      };

      const allTools = toolRegistry.getOpenAITools(availabilityContext, definitionContext);
      const filteredTools = allTools.filter((t: any) => t.function?.name !== 'ejecutar_accion');

      if (filteredTools.length === 0) {
        return this.success('No hay herramientas disponibles para ejecutar en este contexto.');
      }

      const toolContext: ToolContext = {
        businessId,
        instanceId,
        contactPhone,
        contactName: convContext.contact?.name || contactName,
        currencySymbol: businessContext.currencySymbol,
        currencyCode: businessContext.currencyCode,
        business: businessContext.business,
        contact: convContext.contact,
        existingOrder: convContext.existingOrder,
        extractedData: convContext.extractedData,
        conversationMessages: conversationMessages || []
      };

      const memory: ToolMemory = {
        productData: [],
        calculatedTotals: {},
        toolHistory: []
      };

      const productCatalog = this.buildProductCatalog(businessContext.products);
      const zoneCatalog = this.buildZoneCatalog(businessContext.deliveryZones);

      console.log(`[LLM2-Delegate] ═══════════════════════════════════════════════════════`);
      console.log(`[LLM2-Delegate] 🎯 OBJECTIVE: ${objetivo}`);
      console.log(`[LLM2-Delegate] 📋 Context:`);
      console.log(`[LLM2-Delegate]   └─ businessId: ${businessId?.slice(0, 8)}...`);
      console.log(`[LLM2-Delegate]   └─ instanceId: ${instanceId?.slice(0, 8) || 'NONE'}`);
      console.log(`[LLM2-Delegate]   └─ phone: ${contactPhone?.slice(-4) ? '***' + contactPhone.slice(-4) : 'NONE'}`);
      console.log(`[LLM2-Delegate]   └─ existingOrder: ${convContext.existingOrder?.id?.slice(0, 8) || 'NONE'}`);
      console.log(`[LLM2-Delegate] 📦 Products in catalog: ${businessContext.products.length}`);
      console.log(`[LLM2-Delegate] 🌍 Zones in catalog: ${businessContext.deliveryZones.length}`);
      if (DEBUG_AGENT) {
        console.log(`[LLM2-Delegate] 📖 Product catalog preview: ${productCatalog.substring(0, 200)}...`);
      }

      const systemPrompt = `Eres un ejecutor de acciones. Tu trabajo es completar el OBJETIVO usando las herramientas en el orden correcto.

OBJETIVO: ${objetivo}
${contextoAdicional ? `CONTEXTO ADICIONAL: ${contextoAdicional}` : ''}

CATÁLOGO DE PRODUCTOS (muestra):
${productCatalog}

ZONAS DE ENVÍO:
${zoneCatalog}

${convContext.existingOrder ? `⚠️ ORDEN ACTIVA DETECTADA:
   orderId: "${convContext.existingOrder.id}"
   Estado: ${convContext.existingOrder.status}
   
   🚨 IMPORTANTE: Si el cliente quiere agregar productos, USA agregar_producto_orden (NO confirmar_pedido)
   NUNCA uses confirmar_pedido cuando hay orden activa - siempre usa agregar_producto_orden para añadir productos.` : 'Sin orden activa - puedes crear nueva orden con confirmar_pedido'}

${!convContext.existingOrder ? `SECUENCIA PARA NUEVA ORDEN:
1. buscar_producto({ busqueda: "producto" }) → Guarda productId (UUID) y variation EXACTA
2. calcular_total_pedido({ productos: [...], zona_envio: "zona" }) → Confirma total y obtén zoneId
3. confirmar_pedido({ items: [...], deliveryZoneId: "uuid", ... })

⚠️ FORMATO ITEMS[] PARA CONFIRMAR_PEDIDO:
{
  "items": [{"productId": "UUID-EXACTO", "quantity": 1, "variation": "NOMBRE-EXACTO"}],
  "deliveryZoneId": "UUID-DE-ZONA"
}` : `SECUENCIA PARA AGREGAR PRODUCTOS (UPSELLING):
1. buscar_producto({ busqueda: "producto" }) → Guarda productId (UUID) y variation EXACTA
2. agregar_producto_orden({ productId: "UUID", variation: "EXACTA", quantity: 1 })

⚠️ NO uses confirmar_pedido - la orden ya existe. Solo agrega productos con agregar_producto_orden.`}

REGLAS CRÍTICAS:
✅ productId: Usa el UUID EXACTO retornado por buscar_producto
✅ variation: Usa el nombre EXACTO como viene de la DB (ej: "100 ml", NO "100ml")
${convContext.existingOrder ? `✅ Orden activa: Usa agregar_producto_orden, NUNCA confirmar_pedido` : `✅ deliveryZoneId: Requerido para confirmar_pedido`}

ERRORES A EVITAR:
❌ Inventar UUIDs - Usa SOLO los que retorna buscar_producto
❌ Modificar el nombre de variation - "100 ml" ≠ "100ml" ≠ "100ML"
${convContext.existingOrder ? `❌ Usar confirmar_pedido cuando ya hay orden activa - usa agregar_producto_orden` : `❌ Omitir deliveryZoneId cuando usas items[] en confirmar_pedido`}`;

      const llmProvider = LLMFactory.getProvider('openai');
      const llmMessages: any[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Ejecuta: ${objetivo}` }
      ];

      const llmConfig = { model: 'gpt-4o', temperature: 0.2, maxTokens: 2000 };
      const toolsExecuted: Array<{ name: string; success: boolean; result: string; data?: any }> = [];
      
      console.log(`[LLM2-Delegate] Tools available for LLM2: ${filteredTools.map((t: any) => t.function?.name).join(', ')}`);
      console.log(`[LLM2-Delegate] Calling LLM2 (${llmConfig.model})...`);
      
      const llm2StartTime = Date.now();
      let response = await llmProvider.chat(llmMessages, llmConfig, filteredTools);
      console.log(`[LLM2-Delegate] LLM2 initial response (${Date.now() - llm2StartTime}ms): finish=${response.finishReason}, toolCalls=${response.toolCalls?.length || 0}`);
      
      let iterations = 0;

      while (response.finishReason === 'tool_calls' && response.toolCalls && iterations < maxIterations) {
        console.log(`[LLM2-Delegate] ─── ITERATION ${iterations + 1}/${maxIterations} ───`);
        console.log(`[LLM2-Delegate] Processing ${response.toolCalls.length} tool call(s)`);

        const toolResults: any[] = [];

        for (const toolCall of response.toolCalls) {
          let actualToolName = toolCall.name;
          let actualArgs = toolCall.arguments;
          
          console.log(`[LLM2-Delegate]   🔧 Tool requested: ${toolCall.name}`);
          if (DEBUG_AGENT) {
            console.log(`[LLM2-Delegate]   📥 Args: ${redactForLog(toolCall.arguments)}`);
          }
          
          // GUARD: If LLM2 tries to use confirmar_pedido when there's an active order, redirect to agregar_producto_orden
          if (toolCall.name === 'confirmar_pedido' && convContext.existingOrder) {
            console.log(`[LLM2-Delegate]   ⚠️ GUARD TRIGGERED: Active order exists, redirecting to agregar_producto_orden`);
            
            // Extract ALL items from items[] to add via agregar_producto_orden
            const items = actualArgs.items || [];
            if (items.length > 0) {
              // Add all items one by one to the existing order
              for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const addArgs = {
                  productId: item.productId,
                  variation: item.variation,
                  quantity: item.quantity || 1
                };
                
                this.log(`[ejecutar_accion] Redirecting item ${i + 1}/${items.length} to agregar_producto_orden:`, addArgs);
                
                const addResult = await toolRegistry.executeTool('agregar_producto_orden', addArgs, toolContext);
                
                if (i === items.length - 1) {
                  // Use the last result as the main result
                  actualToolName = 'agregar_producto_orden';
                  actualArgs = addArgs;
                }
                
                toolsExecuted.push({
                  name: 'agregar_producto_orden',
                  success: addResult.success,
                  result: addResult.content,
                  data: addResult.data
                });
              }
              
              // Skip normal execution since we already processed all items
              continue;
            }
          }
          
          console.log(`[LLM2-Delegate]   → Executing: ${actualToolName}`);
          
          const toolExecStart = Date.now();
          let result = await toolRegistry.executeTool(
            actualToolName,
            actualArgs,
            toolContext
          );
          const toolExecDuration = Date.now() - toolExecStart;
          
          console.log(`[LLM2-Delegate]   📤 Result (${toolExecDuration}ms): ${result.success ? '✓ SUCCESS' : '✗ FAILED'}`);
          if (DEBUG_AGENT) {
            console.log(`[LLM2-Delegate]   📄 Output: ${redactForLog(result.content)}`);
          }
          
          // GUARD: If result contains _action: USE_AGREGAR_PRODUCTO_ORDEN, auto-redirect
          if (result.data?._action === 'USE_AGREGAR_PRODUCTO_ORDEN') {
            console.log(`[LLM2-Delegate]   ⚠️ POST-GUARD: _action redirect to agregar_producto_orden`);
            
            // Extract first item from original args to use in agregar_producto_orden
            const items = toolCall.arguments.items || [];
            if (items.length > 0) {
              const firstItem = items[0];
              const redirectArgs = {
                productId: firstItem.productId,
                variation: firstItem.variation,
                quantity: firstItem.quantity || 1
              };
              
              result = await toolRegistry.executeTool('agregar_producto_orden', redirectArgs, toolContext);
              this.log(`[ejecutar_accion] Auto-redirected to agregar_producto_orden, result:`, result.success);
            }
          }
          
          // Filter out internal messages so they never reach the customer
          let displayContent = result.content;
          if (result.data?._internal) {
            displayContent = ''; // Don't show internal instructions to LLM for final response
          }

          this.updateMemory(memory, actualToolName, result, iterations);

          toolsExecuted.push({
            name: actualToolName,
            success: result.success,
            result: displayContent,
            data: result.data
          });

          memory.toolHistory.push({
            name: actualToolName,
            success: result.success,
            iteration: iterations
          });

          const enrichedContent = this.enrichResultWithMemory(displayContent || result.content, memory);

          toolResults.push({
            role: 'tool',
            content: enrichedContent,
            tool_call_id: toolCall.id
          });
        }

        llmMessages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
          }))
        });
        llmMessages.push(...toolResults);

        // Siempre agregar la memoria si hay productos encontrados
        if (memory.productData.length > 0) {
          const memoryReminder = this.buildMemoryReminder(memory);
          llmMessages.push({
            role: 'system',
            content: memoryReminder
          });
        }

        console.log(`[LLM2-Delegate] Calling LLM2 again after tool results...`);
        const llmLoopStart = Date.now();
        response = await llmProvider.chat(llmMessages, llmConfig, filteredTools);
        console.log(`[LLM2-Delegate] LLM2 response (${Date.now() - llmLoopStart}ms): finish=${response.finishReason}, moreTools=${response.toolCalls?.length || 0}`);
        iterations++;
      }

      const finalContent = response.content || 'No se pudo completar la acción.';
      const totalDuration = Date.now() - startTime;

      const resultData = {
        toolsExecuted: toolsExecuted.map(t => ({ name: t.name, success: t.success })),
        iterations,
        memory: {
          productsFound: memory.productData.length,
          calculatedTotal: memory.calculatedTotals.total,
          orderId: memory.orderId
        }
      };

      const summary = toolsExecuted.map(t => 
        `${t.success ? '✓' : '✗'} ${t.name}`
      ).join(' → ');

      console.log(`[LLM2-Delegate] ═══════════════════════════════════════════════════════`);
      console.log(`[LLM2-Delegate] ✓ ejecutar_accion COMPLETED in ${totalDuration}ms`);
      console.log(`[LLM2-Delegate] Iterations: ${iterations}, Tools: ${toolsExecuted.length}`);
      console.log(`[LLM2-Delegate] Flow: ${summary || 'no tools executed'}`);
      console.log(`[LLM2-Delegate] Memory: products=${memory.productData.length}, total=${memory.calculatedTotals.total || 'N/A'}, orderId=${memory.orderId?.slice(0, 8) || 'none'}`);
      if (DEBUG_AGENT) {
        console.log(`[LLM2-Delegate] Response preview: ${redactForLog(finalContent, 100)}`);
      }
      console.log(`[LLM2-Delegate] ═══════════════════════════════════════════════════════`);

      return this.success(finalContent, resultData);

    } catch (error: any) {
      console.error(`[LLM2-Delegate] ═══════════════════════════════════════════════════════`);
      console.error(`[LLM2-Delegate] ✗ ERROR in ejecutar_accion: ${error.message}`);
      console.error(`[LLM2-Delegate] Stack: ${error.stack}`);
      console.error(`[LLM2-Delegate] ═══════════════════════════════════════════════════════`);
      return this.error(`Error al ejecutar acción: ${error.message}`);
    }
  }

  private buildProductCatalog(products: any[]): string {
    if (products.length === 0) return 'Sin productos';
    
    const sample = products.slice(0, 15);
    return sample.map(p => {
      const variation = p.variation ? ` [${p.variation}]` : '';
      return `- ${p.title}${variation}: S/${p.price}${p.stock !== null ? ` (stock: ${p.stock})` : ''}`;
    }).join('\n');
  }

  private buildZoneCatalog(zones: any[]): string {
    if (zones.length === 0) return 'Sin zonas configuradas';
    
    return zones.map(z => {
      const free = z.freeAbove ? ` (gratis desde S/${z.freeAbove})` : '';
      return `- ${z.name}: S/${z.cost}${free}`;
    }).join('\n');
  }

  private updateMemory(memory: ToolMemory, toolName: string, result: any, iteration: number): void {
    if (toolName === 'buscar_producto' && result.success) {
      // Usar result.data.products si está disponible (datos estructurados)
      const products = result.data?.products;
      
      if (products && Array.isArray(products)) {
        for (const product of products) {
          const existing = memory.productData.find(p => 
            p.productId === product.id || 
            (p.title.toLowerCase() === product.title?.toLowerCase() && p.variation === product.variation)
          );
          
          if (!existing) {
            memory.productData.push({
              productId: product.id || `found_${memory.productData.length}`,
              title: product.title,
              variation: product.variation || undefined,
              price: product.price,
              stock: product.stock ?? undefined,
              imageUrl: product.imageUrl || undefined
            });
          }
        }
      } else {
        // Fallback a regex si no hay datos estructurados
        const content = result.content;
        const productMatches = content.matchAll(/• ([^:]+)(?:\s*\(([^)]+)\))?:\s*S\/(\d+(?:\.\d+)?)/g);
        
        for (const match of productMatches) {
          const existing = memory.productData.find(p => 
            p.title.toLowerCase() === match[1].trim().toLowerCase()
          );
          
          if (!existing) {
            memory.productData.push({
              productId: `found_${memory.productData.length}`,
              title: match[1].trim(),
              variation: match[2]?.trim(),
              price: parseFloat(match[3])
            });
          }
        }
      }
    }

    if (toolName === 'calcular_total_pedido' && result.success) {
      const data = result.data;
      if (data) {
        memory.calculatedTotals = {
          subtotal: data.subtotal,
          shipping: data.shipping,
          total: data.total,
          zone: data.zone,
          zoneId: data.zoneId
        };
      }
    }

    if (toolName === 'confirmar_pedido' && result.success) {
      const data = result.data;
      if (data?.orderId) {
        memory.orderId = data.orderId;
        memory.orderStatus = data.status || 'CREATED';
      } else {
        // Fallback a regex
        const orderMatch = result.content.match(/ID[:\s]*([a-f0-9-]+)/i);
        if (orderMatch) {
          memory.orderId = orderMatch[1];
          memory.orderStatus = 'CREATED';
        }
      }
    }
  }

  private enrichResultWithMemory(content: string, memory: ToolMemory): string {
    let enriched = content;
    
    if (memory.productData.length > 0) {
      enriched += `\n\n[MEMORIA: Productos encontrados: ${memory.productData.map(p => `${p.title} S/${p.price}`).join(', ')}]`;
    }
    
    if (memory.calculatedTotals.total) {
      enriched += `\n[MEMORIA: Total calculado: S/${memory.calculatedTotals.total} (envío a ${memory.calculatedTotals.zone})]`;
    }
    
    return enriched;
  }

  private formatMemory(memory: ToolMemory): string {
    const parts: string[] = [];
    
    if (memory.productData.length > 0) {
      parts.push(`PRODUCTOS ENCONTRADOS (usa productId y variation EXACTOS para crear pedido):`);
      memory.productData.forEach(p => {
        const variationStr = p.variation ? `, "variation": "${p.variation}"` : '';
        parts.push(`  • productId: "${p.productId}" → ${p.title}${p.variation ? ` (${p.variation})` : ''}: S/${p.price}`);
        parts.push(`    Para items[]: {"productId": "${p.productId}", "quantity": 1${variationStr}}`);
      });
    }
    
    if (memory.calculatedTotals.total) {
      parts.push(`\nCÁLCULO REALIZADO:`);
      parts.push(`  Subtotal: S/${memory.calculatedTotals.subtotal}`);
      parts.push(`  Envío (${memory.calculatedTotals.zone}): S/${memory.calculatedTotals.shipping}`);
      parts.push(`  TOTAL: S/${memory.calculatedTotals.total}`);
    }
    
    if (memory.orderId) {
      parts.push(`\nORDEN: ID=${memory.orderId}`);
    }
    
    parts.push(`\nHERRAMIENTAS USADAS: ${memory.toolHistory.map(t => t.name).join(' → ')}`);
    
    return parts.join('\n');
  }

  private buildMemoryReminder(memory: ToolMemory): string {
    const parts: string[] = ['⚠️ RECORDATORIO: Usa estos datos de la memoria para tu siguiente llamada:'];
    
    if (memory.productData.length > 0) {
      parts.push('\nPRODUCTOS YA ENCONTRADOS (usa estos UUIDs para crear pedido):');
      memory.productData.forEach(p => {
        const variation = p.variation ? ` (${p.variation})` : '';
        let productLine = `  • productId: "${p.productId}" → "${p.title}${variation}" S/${p.price}`;
        if (p.imageUrl) {
          productLine += ` | img: ${p.imageUrl}`;
        }
        parts.push(productLine);
      });
      
      // Ejemplo de cómo crear pedido con UUIDs
      const firstProduct = memory.productData[0];
      parts.push(`\nPARA CREAR PEDIDO, USA LOS productId ASÍ:`);
      parts.push(`confirmar_pedido({
  items: [{ productId: "${firstProduct.productId}", quantity: 1, variation: "${firstProduct.variation || ''}" }],
  deliveryZoneId: "UUID_DE_ZONA",
  nombre_cliente: "Nombre",
  direccion: "Dirección",
  metodo_pago: "YAPE"
})`);
    }
    
    if (memory.calculatedTotals.total) {
      parts.push(`\n✅ TOTAL YA CALCULADO: S/${memory.calculatedTotals.total} (envío a ${memory.calculatedTotals.zone})`);
      if (memory.calculatedTotals.zoneId) {
        parts.push(`   deliveryZoneId: "${memory.calculatedTotals.zoneId}"`);
      }
      parts.push(`Ya puedes responder con este total, no necesitas calcularlo de nuevo.`);
    }
    
    if (memory.orderId) {
      parts.push(`\n📦 ORDEN CREADA: orderId="${memory.orderId}"`);
      parts.push(`Para agregar voucher usa esta estructura exacta:`);
      parts.push(`registrar_voucher_pago({ orderId: "${memory.orderId}", voucherImageUrl: "URL_DEL_VOUCHER", amount: MONTO, paymentMethod: "YAPE", autoConfirm: false })`);
    }
    
    return parts.join('\n');
  }
}

export function registerDelegateOrchestratorTool(): void {
  toolRegistry.registerTool(new DelegateToolExecutionTool());
  console.log('[ToolRegistry] DelegateToolExecutionTool (ejecutar_accion) registered');
}

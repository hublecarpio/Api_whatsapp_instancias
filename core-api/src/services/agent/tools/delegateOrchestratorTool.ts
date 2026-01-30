import { BaseTool, ToolCategory, ToolDefinition, ToolContext, ToolResult, ToolAvailabilityContext, ToolDefinitionContext, toolRegistry } from '../core/index.js';
import { LLMFactory } from '../core/llmAdapter.js';
import { loadBusinessContext, loadConversationContext } from '../prompts/contextBuilder.js';
import { loadCustomToolsForBusiness } from './customToolAdapter.js';

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
        description: 'Agrega producto a orden existente',
        payload: '{ producto: "nombre", cantidad: 1 }',
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
    this.log('Executing action delegation', args);

    const { businessId, instanceId, contactPhone, contactName, conversationMessages } = context;
    const objetivo = args.objetivo;
    const contextoAdicional = args.contexto_adicional || '';
    const maxIterations = 5;

    if (!objetivo) {
      return this.error('Debes especificar el objetivo de la acción.');
    }

    try {
      await loadCustomToolsForBusiness(businessId);

      const businessContext = await loadBusinessContext(businessId, instanceId);
      const convContext = await loadConversationContext(businessId, contactPhone, instanceId);

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

      const systemPrompt = `Eres un ejecutor de acciones. Tu trabajo es completar el OBJETIVO usando las herramientas en el orden correcto.

OBJETIVO: ${objetivo}
${contextoAdicional ? `CONTEXTO ADICIONAL: ${contextoAdicional}` : ''}

CATÁLOGO DE PRODUCTOS (muestra):
${productCatalog}

ZONAS DE ENVÍO:
${zoneCatalog}

${convContext.existingOrder ? `ORDEN ACTIVA: ID=${convContext.existingOrder.id}, Estado=${convContext.existingOrder.status}` : 'Sin orden activa'}

SECUENCIA OBLIGATORIA PARA CALCULAR TOTAL:
1. PRIMERO: buscar_producto({ busqueda: "nombre del producto" })
2. SEGUNDO: calcular_total_pedido({ productos: [{ nombre: "NOMBRE EXACTO del producto encontrado", cantidad: N }], zona_envio: "zona" })

EJEMPLO CORRECTO:
- buscar_producto({ busqueda: "Erba Pura 100ml" }) → Retorna: "Erba Pura (100ml): S/109.90"
- calcular_total_pedido({ productos: [{ nombre: "Erba Pura", cantidad: 1 }], zona_envio: "Lima" }) → Retorna: Total con envío

ERRORES A EVITAR:
❌ calcular_total_pedido({ zona_envio: "Lima" }) - FALTA productos[]!
❌ Inventar precios sin usar las herramientas
❌ Responder sin haber calculado el total

IMPORTANTE: Usa el nombre del producto TAL CUAL lo retornó buscar_producto.`;

      const llmProvider = LLMFactory.getProvider('openai');
      const llmMessages: any[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Ejecuta: ${objetivo}` }
      ];

      const llmConfig = { model: 'gpt-4o', temperature: 0.2, maxTokens: 2000 };
      const toolsExecuted: Array<{ name: string; success: boolean; result: string; data?: any }> = [];
      
      let response = await llmProvider.chat(llmMessages, llmConfig, filteredTools);
      let iterations = 0;

      while (response.finishReason === 'tool_calls' && response.toolCalls && iterations < maxIterations) {
        this.log(`[ejecutar_accion] Iteration ${iterations + 1}: executing ${response.toolCalls.length} tools`);

        const toolResults: any[] = [];

        for (const toolCall of response.toolCalls) {
          this.log(`[ejecutar_accion] Executing: ${toolCall.name}`, toolCall.arguments);
          
          const result = await toolRegistry.executeTool(
            toolCall.name,
            toolCall.arguments,
            toolContext
          );

          this.updateMemory(memory, toolCall.name, result, iterations);

          toolsExecuted.push({
            name: toolCall.name,
            success: result.success,
            result: result.content,
            data: result.data
          });

          memory.toolHistory.push({
            name: toolCall.name,
            success: result.success,
            iteration: iterations
          });

          const enrichedContent = this.enrichResultWithMemory(result.content, memory);

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

        response = await llmProvider.chat(llmMessages, llmConfig, filteredTools);
        iterations++;
      }

      const finalContent = response.content || 'No se pudo completar la acción.';

      const resultData = {
        toolsExecuted: toolsExecuted.map(t => ({ name: t.name, success: t.success })),
        iterations,
        memory: {
          productsFound: memory.productData.length,
          calculatedTotal: memory.calculatedTotals.total,
          orderId: memory.orderId
        }
      };

      if (toolsExecuted.length === 0) {
        return this.success(finalContent, resultData);
      }

      const summary = toolsExecuted.map(t => 
        `${t.success ? '✓' : '✗'} ${t.name}`
      ).join(' → ');

      this.log(`[ejecutar_accion] Completed: ${summary}, iterations=${iterations}`);

      return this.success(finalContent, resultData);

    } catch (error: any) {
      this.logError('Error in ejecutar_accion', error);
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
          zone: data.zone
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
      parts.push(`PRODUCTOS ENCONTRADOS:`);
      memory.productData.forEach(p => {
        parts.push(`  - ${p.title}${p.variation ? ` (${p.variation})` : ''}: S/${p.price}`);
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
      parts.push('\nPRODUCTOS YA ENCONTRADOS:');
      memory.productData.forEach(p => {
        const variation = p.variation ? ` (${p.variation})` : '';
        let productLine = `  • "${p.title}${variation}" - S/${p.price}`;
        if (p.imageUrl) {
          productLine += ` | Imagen: ${p.imageUrl}`;
        }
        parts.push(productLine);
      });
      
      // Dar ejemplo concreto de cómo usarlos
      const firstProduct = memory.productData[0];
      parts.push(`\nPARA CALCULAR TOTAL, USA:`);
      parts.push(`calcular_total_pedido({ productos: [{ nombre: "${firstProduct.title}", cantidad: 1 }], zona_envio: "ZONA" })`);
    }
    
    if (memory.calculatedTotals.total) {
      parts.push(`\n✅ TOTAL YA CALCULADO: S/${memory.calculatedTotals.total} (envío a ${memory.calculatedTotals.zone})`);
      parts.push(`Ya puedes responder con este total, no necesitas calcularlo de nuevo.`);
    }
    
    return parts.join('\n');
  }
}

export function registerDelegateOrchestratorTool(): void {
  toolRegistry.registerTool(new DelegateToolExecutionTool());
  console.log('[ToolRegistry] DelegateToolExecutionTool (ejecutar_accion) registered');
}

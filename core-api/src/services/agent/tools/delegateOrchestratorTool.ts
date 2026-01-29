import { BaseTool, ToolCategory, ToolDefinition, ToolContext, ToolResult, ToolAvailabilityContext, ToolDefinitionContext, toolRegistry } from '../core/index.js';
import { LLMFactory } from '../core/llmAdapter.js';
import { loadBusinessContext, loadConversationContext } from '../prompts/contextBuilder.js';
import { loadCustomToolsForBusiness } from './customToolAdapter.js';

export class DelegateToolExecutionTool extends BaseTool {
  readonly name = 'delegate_tool_execution';
  readonly category: ToolCategory = 'CUSTOM';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    return {
      name: this.name,
      description: `Delega la ejecución de herramientas a un modelo especializado en razonamiento. 
Usa esta función cuando necesites ejecutar acciones complejas como crear órdenes, buscar productos, o agendar citas.
El modelo especializado analizará la solicitud y ejecutará las herramientas necesarias automáticamente.
Retorna el resultado de las herramientas ejecutadas y una respuesta sugerida.`,
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'La solicitud o acción que se debe ejecutar (ej: "crear orden de 2 pizzas para calle falsa 123")'
          },
          model: {
            type: 'string',
            description: 'Modelo a usar para el razonamiento (default: gpt-4o)'
          },
          maxIterations: {
            type: 'number',
            description: 'Número máximo de iteraciones para completar la ejecución (default: 3)'
          }
        },
        required: ['query']
      }
    };
  }

  isAvailable(context: ToolAvailabilityContext): boolean {
    return true;
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('Delegating tool execution', args);

    const { businessId, instanceId, contactPhone, contactName, conversationMessages } = context;
    const query = args.query;
    const model = args.model || 'gpt-4o';
    const maxIterations = Math.min(Math.max(1, args.maxIterations || 3), 5);

    if (!query) {
      return this.error('Debes especificar la query/acción a ejecutar.');
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
        zoneDescriptions: businessContext.deliveryZones.map((z: any) => z.name).join(', '),
        businessObjective: businessContext.businessObjective
      };

      const allTools = toolRegistry.getOpenAITools(availabilityContext, definitionContext);
      const filteredTools = allTools.filter((t: any) => t.function?.name !== 'delegate_tool_execution');

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

      const contextSummary = this.buildContextSummary(businessContext, convContext);

      const systemPrompt = `Eres un orquestador de herramientas especializado. Tu trabajo es:
1. Analizar la query del usuario y el contexto disponible
2. Decidir qué herramienta(s) usar para satisfacer la solicitud
3. Ejecutar las herramientas con los parámetros correctos
4. Si falta información, indicar qué datos se necesitan

CONTEXTO:
${contextSummary}

REGLAS:
- Solo usa herramientas cuando sea necesario
- Si no tienes todos los datos requeridos, indica qué información falta
- Sé preciso con los parámetros`;

      const llmProvider = LLMFactory.getProvider('openai');
      const llmMessages: any[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query }
      ];

      const llmConfig = { model, temperature: 0.3, maxTokens: 2000 };
      const toolsExecuted: Array<{ name: string; success: boolean; result: string }> = [];
      
      let response = await llmProvider.chat(llmMessages, llmConfig, filteredTools);
      let iterations = 0;

      while (response.finishReason === 'tool_calls' && response.toolCalls && iterations < maxIterations) {
        this.log(`Iteration ${iterations + 1}: executing ${response.toolCalls.length} tools`);

        const toolResults: any[] = [];

        for (const toolCall of response.toolCalls) {
          this.log(`Executing delegated tool: ${toolCall.name}`);
          
          const result = await toolRegistry.executeTool(
            toolCall.name,
            toolCall.arguments,
            toolContext
          );

          toolsExecuted.push({
            name: toolCall.name,
            success: result.success,
            result: result.content
          });

          toolResults.push({
            role: 'tool',
            content: result.content,
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

        response = await llmProvider.chat(llmMessages, llmConfig, filteredTools);
        iterations++;
      }

      const finalContent = response.content || 'No se pudo generar respuesta.';

      const needsMoreData = this.detectMissingData(finalContent);

      const resultData = {
        toolsExecuted: toolsExecuted.map(t => ({ name: t.name, success: t.success })),
        iterations,
        model,
        needsMoreData: needsMoreData.missing,
        missingFields: needsMoreData.fields
      };

      if (toolsExecuted.length === 0) {
        return this.success(finalContent, resultData);
      }

      const summary = toolsExecuted.map(t => 
        `${t.success ? '✓' : '✗'} ${t.name}`
      ).join(', ');

      return this.success(
        `[Herramientas ejecutadas: ${summary}]\n\n${finalContent}`,
        resultData
      );

    } catch (error: any) {
      this.logError('Error in delegate_tool_execution', error);
      return this.error(`Error al delegar ejecución: ${error.message}`);
    }
  }

  private buildContextSummary(businessContext: any, convContext: any): string {
    const parts: string[] = [];

    if (businessContext.business) {
      parts.push(`Negocio: ${businessContext.business.name}`);
    }

    if (businessContext.products.length > 0) {
      const productList = businessContext.products.slice(0, 5).map((p: any) => 
        `- ${p.title}: ${businessContext.currencySymbol}${p.price}`
      ).join('\n');
      parts.push(`\nProductos:\n${productList}`);
    }

    if (businessContext.deliveryZones.length > 0) {
      parts.push(`Zonas: ${businessContext.deliveryZones.map((z: any) => z.name).join(', ')}`);
    }

    if (convContext.existingOrder) {
      parts.push(`Orden existente: ID ${convContext.existingOrder.id}, Estado: ${convContext.existingOrder.status}`);
    }

    if (convContext.contact) {
      parts.push(`Contacto: ${convContext.contact.name || convContext.contact.phone}`);
    }

    return parts.join('\n');
  }

  private detectMissingData(content: string): { missing: boolean; fields: string[] } {
    const missingIndicators = [
      /necesito\s+(saber|conocer|que me (digas|proporciones))/i,
      /falta\s+(el|la|información)/i,
      /cuál\s+es\s+(tu|su)/i,
      /podrías\s+(indicarme|decirme)/i,
      /requiero\s+(el|la|los|las)/i
    ];

    const fieldPatterns: { [key: string]: RegExp } = {
      'direccion': /direcci[oó]n|domicilio|ubicaci[oó]n/i,
      'telefono': /tel[eé]fono|n[uú]mero|celular/i,
      'nombre': /nombre|c[oó]mo te llamas/i,
      'metodoPago': /m[eé]todo de pago|forma de pago|c[oó]mo (pagar[aá]s|deseas pagar)/i,
      'zona': /zona|sector|[aá]rea de entrega/i,
      'producto': /producto|qu[eé] deseas|qu[eé] quieres/i,
      'cantidad': /cantidad|cu[aá]ntos|cu[aá]ntas/i
    };

    const missing = missingIndicators.some(pattern => pattern.test(content));
    const fields: string[] = [];

    if (missing) {
      for (const [field, pattern] of Object.entries(fieldPatterns)) {
        if (pattern.test(content)) {
          fields.push(field);
        }
      }
    }

    return { missing, fields };
  }
}

export function registerDelegateOrchestratorTool(): void {
  toolRegistry.registerTool(new DelegateToolExecutionTool());
  console.log('[ToolRegistry] DelegateToolExecutionTool registered');
}

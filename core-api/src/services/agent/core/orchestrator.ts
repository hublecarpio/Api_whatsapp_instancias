import { ToolContext, ToolAvailabilityContext, ToolDefinitionContext, LLMMessage, LLMConfig, OpenAIToolFormat, ChatMessage } from './types.js';
import { toolRegistry } from './toolRegistry.js';
import { LLMFactory, ILLMProvider } from './llmAdapter.js';
import { ContextBuilder, BusinessContext, ConversationContext, TriggerContext, loadBusinessContext, loadConversationContext, loadConversationHistory } from '../prompts/contextBuilder.js';
import { loadCustomToolsForBusiness } from '../tools/customToolAdapter.js';
import { registerAllNativeTools } from '../tools/index.js';
import { triggerFunnelEvaluation } from '../funnelStageEvaluator.js';
import { analyzeAndUpdateLeadStage } from '../../leadStageService.js';

export interface OrchestratorConfig {
  maxToolCalls?: number;
  llmProvider?: 'openai' | 'openrouter';
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface OrchestratorInput {
  businessId: string;
  instanceId: string | null;
  contactPhone: string;
  contactName: string;
  messages: ChatMessage[];
  triggerContext?: TriggerContext;
  config?: OrchestratorConfig;
}

export interface OrchestratorOutput {
  response: string;
  toolsExecuted: Array<{ name: string; success: boolean; result: string }>;
  tokensUsed: {
    prompt: number;
    completion: number;
    total: number;
  };
  metadata: {
    model: string;
    llmCalls: number;
    processingTimeMs: number;
  };
}

let toolsInitialized = false;

export class AgentOrchestrator {
  private llmProvider: ILLMProvider;
  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig = {}) {
    this.config = {
      maxToolCalls: config.maxToolCalls ?? 5,
      llmProvider: config.llmProvider ?? 'openai',
      model: config.model ?? 'gpt-4o-mini',
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 2000
    };
    
    this.llmProvider = LLMFactory.getProvider(this.config.llmProvider);
    
    if (!toolsInitialized) {
      registerAllNativeTools();
      toolsInitialized = true;
    }
  }

  async process(input: OrchestratorInput): Promise<OrchestratorOutput> {
    const startTime = Date.now();
    console.log(`[Orchestrator] Processing message for ${input.contactPhone}, businessId=${input.businessId}, instanceId=${input.instanceId}`);

    const toolsExecuted: OrchestratorOutput['toolsExecuted'] = [];
    let totalTokens = { prompt: 0, completion: 0, total: 0 };
    let llmCalls = 0;
    let currentStep = 'init';

    try {
      currentStep = 'loadCustomTools';
      console.log(`[Orchestrator] Step: ${currentStep}`);
      await loadCustomToolsForBusiness(input.businessId);

      currentStep = 'loadBusinessContext';
      console.log(`[Orchestrator] Step: ${currentStep}`);
      const businessContext = await loadBusinessContext(input.businessId, input.instanceId);
      console.log(`[Orchestrator] BusinessContext loaded: business=${businessContext.business?.name}, products=${businessContext.products.length}, zones=${businessContext.deliveryZones.length}`);

      currentStep = 'loadConversationContext';
      console.log(`[Orchestrator] Step: ${currentStep}`);
      const [convContextPartial, historyMessages] = await Promise.all([
        loadConversationContext(input.businessId, input.contactPhone, input.instanceId),
        loadConversationHistory(input.businessId, input.contactPhone, input.instanceId, 20)
      ]);
      console.log(`[Orchestrator] ConversationContext loaded: contact=${convContextPartial.contact?.name || 'none'}, order=${convContextPartial.existingOrder?.id || 'none'}, history=${historyMessages.length} msgs`);
      
      const allMessages = combineMessages(historyMessages, input.messages);
      console.log(`[Orchestrator] Messages: history=${historyMessages.length}, new=${input.messages.length}, combined=${allMessages.length}`);
      
      const conversationContext: ConversationContext = {
        ...convContextPartial,
        messages: allMessages
      };

      currentStep = 'buildContext';
      console.log(`[Orchestrator] Step: ${currentStep}`);
      const contextBuilder = new ContextBuilder(
        businessContext,
        conversationContext,
        input.triggerContext || {}
      );
      
      const builtContext = await contextBuilder.build();
      console.log(`[Orchestrator] Context built: systemPrompt=${builtContext.systemPrompt?.length || 0} chars, messages=${builtContext.conversationMessages?.length || 0}, stage=${builtContext.metadata.currentStage}, allowedTools=${builtContext.allowedTools.length}`);

      // Usar allowedTools del builder (filtradas por etapa del funnel)
      const hasToolRestriction = builtContext.allowedTools.length > 0;
      
      const availabilityContext: ToolAvailabilityContext = {
        businessId: input.businessId,
        instanceId: input.instanceId,
        hasActiveOrder: !!conversationContext.existingOrder,
        hasProducts: businessContext.products.length > 0,
        hasZones: businessContext.deliveryZones.length > 0,
        hasAppointments: businessContext.hasAppointments,
        businessObjective: businessContext.businessObjective,
        enabledToolNames: hasToolRestriction ? builtContext.allowedTools : undefined
      };

      const definitionContext: ToolDefinitionContext = {
        hasActiveOrder: !!conversationContext.existingOrder,
        hasProducts: businessContext.products.length > 0,
        hasZones: businessContext.deliveryZones.length > 0,
        hasAppointments: businessContext.hasAppointments,
        zoneDescriptions: businessContext.deliveryZones.map(z => z.name).join(', '),
        businessObjective: businessContext.businessObjective
      };

      currentStep = 'getTools';
      const allOpenaiTools = toolRegistry.getOpenAITools(availabilityContext, definitionContext);
      
      // LLM1 solo recibe ejecutar_accion como tool principal
      // Las demás tools son manejadas internamente por el delegate (LLM2)
      // PERO respetamos las restricciones de etapa del funnel
      const LLM1_DELEGATE_TOOL = 'ejecutar_accion';
      
      let openaiTools: typeof allOpenaiTools = [];
      
      // Si hay restricciones de etapa, verificar si ejecutar_accion está permitida
      if (hasToolRestriction) {
        // Solo incluir ejecutar_accion si las tools permitidas por etapa lo incluyen
        // O si alguna de las tools permitidas requiere acciones (productos, orders, citas)
        const stageAllowsActions = builtContext.allowedTools.some(tool => 
          ['buscar_producto', 'calcular_total_pedido', 'confirmar_pedido', 
           'agregar_producto_orden', 'consultar_pedido', 'agendar_cita',
           'ejecutar_accion'].includes(tool)
        );
        
        if (stageAllowsActions) {
          openaiTools = allOpenaiTools.filter((t: any) => 
            t.function?.name === LLM1_DELEGATE_TOOL
          );
        }
        // Si no hay acciones permitidas, openaiTools queda vacío (solo conversación)
      } else {
        // Sin restricciones de etapa, dar acceso a ejecutar_accion
        openaiTools = allOpenaiTools.filter((t: any) => 
          t.function?.name === LLM1_DELEGATE_TOOL
        );
      }
      
      console.log(`[Orchestrator] Stage restrictions: ${hasToolRestriction ? builtContext.allowedTools.join(', ') : 'none'}`);
      console.log(`[Orchestrator] LLM1 tools: ${openaiTools.length} - ${openaiTools.map((t: any) => t.function?.name).join(', ')}`);
      console.log(`[Orchestrator] All registered tools (for delegate): ${allOpenaiTools.length}`);

      const toolContext: ToolContext = {
        businessId: input.businessId,
        instanceId: input.instanceId,
        contactPhone: input.contactPhone,
        contactName: input.contactName,
        currencySymbol: businessContext.currencySymbol,
        currencyCode: businessContext.currencyCode,
        business: businessContext.business,
        contact: conversationContext.contact,
        existingOrder: conversationContext.existingOrder,
        extractedData: conversationContext.extractedData,
        conversationMessages: input.messages.filter(m => m.role !== 'system').map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        geminiVoucherResult: input.triggerContext?.geminiVoucherResult
      };

      const llmMessages: LLMMessage[] = [
        { role: 'system', content: builtContext.systemPrompt },
        ...builtContext.conversationMessages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content
        }))
      ];

      const llmConfig: LLMConfig = {
        model: this.config.model!,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens
      };

      currentStep = 'llmCall';
      console.log(`[Orchestrator] Step: ${currentStep} - model=${llmConfig.model}, messages=${llmMessages.length}`);
      let response = await this.llmProvider.chat(llmMessages, llmConfig, openaiTools);
      llmCalls++;
      console.log(`[Orchestrator] LLM response: finishReason=${response.finishReason}, hasContent=${!!response.content}, toolCalls=${response.toolCalls?.length || 0}`);
      
      if (response.usage) {
        totalTokens.prompt += response.usage.promptTokens;
        totalTokens.completion += response.usage.completionTokens;
        totalTokens.total += response.usage.totalTokens;
      }

      let toolCallCount = 0;
      while (response.finishReason === 'tool_calls' && response.toolCalls && toolCallCount < this.config.maxToolCalls!) {
        currentStep = `toolExecution_${toolCallCount}`;
        console.log(`[Orchestrator] Step: ${currentStep} - Processing ${response.toolCalls.length} tool calls`);

        const toolResults: LLMMessage[] = [];

        for (const toolCall of response.toolCalls) {
          console.log(`[Orchestrator] Executing tool: ${toolCall.name} with args: ${JSON.stringify(toolCall.arguments).substring(0, 200)}`);
          
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

        response = await this.llmProvider.chat(llmMessages, llmConfig, openaiTools);
        llmCalls++;
        
        if (response.usage) {
          totalTokens.prompt += response.usage.promptTokens;
          totalTokens.completion += response.usage.completionTokens;
          totalTokens.total += response.usage.totalTokens;
        }

        toolCallCount++;
      }

      const finalResponse = response.content || 'Lo siento, no pude generar una respuesta.';

      const processingTimeMs = Date.now() - startTime;
      console.log(`[Orchestrator] Completed in ${processingTimeMs}ms, ${llmCalls} LLM calls, ${toolsExecuted.length} tools executed`);

      const updatedConversation = [
        ...input.messages.filter(m => m.role !== 'system').map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content
        })),
        { role: 'assistant' as const, content: finalResponse }
      ];
      
      triggerFunnelEvaluation({
        businessId: input.businessId,
        instanceId: input.instanceId,
        contactPhone: input.contactPhone,
        conversationHistory: updatedConversation
      });
      
      analyzeAndUpdateLeadStage(input.businessId, input.contactPhone)
        .then(result => {
          if (result.success && result.newStage) {
            console.log(`[Orchestrator] Lead stage updated to: ${result.newStage}`);
          }
        })
        .catch(err => console.error(`[Orchestrator] Lead stage error:`, err.message));
      
      console.log(`[Orchestrator] Triggered async evaluations for ${input.contactPhone}`);

      return {
        response: finalResponse,
        toolsExecuted,
        tokensUsed: totalTokens,
        metadata: {
          model: this.config.model!,
          llmCalls,
          processingTimeMs
        }
      };
    } catch (error: any) {
      console.error(`[Orchestrator] ERROR at step "${currentStep}":`, error.message);
      console.error(`[Orchestrator] Stack trace:`, error.stack);
      console.error(`[Orchestrator] Input context: businessId=${input.businessId}, instanceId=${input.instanceId}, phone=${input.contactPhone}`);
      
      // Re-throw the error so callers can handle fallback to V1
      throw error;
    }
  }
}

let orchestratorInstance: AgentOrchestrator | null = null;

export function getOrchestrator(config?: OrchestratorConfig): AgentOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new AgentOrchestrator(config);
  }
  return orchestratorInstance;
}

export async function processWithOrchestrator(input: OrchestratorInput): Promise<OrchestratorOutput> {
  // Create a fresh orchestrator per request to respect per-request config (model, temperature, etc.)
  const orchestrator = new AgentOrchestrator(input.config);
  return orchestrator.process(input);
}

function combineMessages(history: ChatMessage[], newMessages: ChatMessage[]): ChatMessage[] {
  if (history.length === 0) {
    return newMessages;
  }
  
  if (newMessages.length === 0) {
    return history;
  }
  
  const lastHistoryContent = history[history.length - 1]?.content?.trim() || '';
  const firstNewContent = newMessages[0]?.content?.trim() || '';
  
  if (lastHistoryContent === firstNewContent) {
    return [...history, ...newMessages.slice(1)];
  }
  
  return [...history, ...newMessages];
}

import { ToolContext, ToolAvailabilityContext, ToolDefinitionContext, LLMMessage, LLMConfig, OpenAIToolFormat, ChatMessage } from './types.js';
import { toolRegistry } from './toolRegistry.js';
import { LLMFactory, ILLMProvider } from './llmAdapter.js';
import { ContextBuilder, BusinessContext, ConversationContext, TriggerContext, loadBusinessContext, loadConversationContext, loadConversationHistory } from '../prompts/contextBuilder.js';
import { loadCustomToolsForBusiness } from '../tools/customToolAdapter.js';
import { registerAllNativeTools } from '../tools/index.js';
import { triggerFunnelEvaluation } from '../funnelStageEvaluator.js';
import { analyzeAndUpdateLeadStage } from '../../leadStageService.js';

// Debug flag for verbose logging - set to true for detailed debugging
const DEBUG_AGENT = process.env.DEBUG_AGENT_V3 === 'true';

// Helper to redact PII from log outputs
function redactForLog(obj: any, maxLen: number = 150): string {
  if (!obj) return 'null';
  let str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  // Redact phone numbers (9+ digits)
  str = str.replace(/\b\d{9,15}\b/g, '***PHONE***');
  // Redact email addresses
  str = str.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '***EMAIL***');
  // Truncate UUIDs to first 8 chars
  str = str.replace(/([a-f0-9]{8})-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '$1...');
  // Truncate to max length
  if (str.length > maxLen) {
    str = str.substring(0, maxLen) + '...';
  }
  return str;
}

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
    const phoneMask = input.contactPhone.length > 4 ? `***${input.contactPhone.slice(-4)}` : '****';
    
    console.log(`[Orchestrator] ═══════════════════════════════════════════════════════`);
    console.log(`[Orchestrator] ▶ STARTING V3 PROCESS`);
    console.log(`[Orchestrator] Phone: ${phoneMask}, Business: ${input.businessId.slice(0, 8)}...`);
    console.log(`[Orchestrator] InstanceId: ${input.instanceId?.slice(0, 8) || 'NULL'}`);
    console.log(`[Orchestrator] Config: model=${this.config.model}, temp=${this.config.temperature}, maxTools=${this.config.maxToolCalls}`);
    console.log(`[Orchestrator] ═══════════════════════════════════════════════════════`);

    const toolsExecuted: OrchestratorOutput['toolsExecuted'] = [];
    let totalTokens = { prompt: 0, completion: 0, total: 0 };
    let llmCalls = 0;
    let currentStep = 'init';

    try {
      currentStep = 'loadCustomTools';
      console.log(`[Orchestrator] [1/7] ${currentStep}`);
      await loadCustomToolsForBusiness(input.businessId);

      currentStep = 'loadBusinessContext';
      console.log(`[Orchestrator] [2/7] ${currentStep}`);
      const businessContext = await loadBusinessContext(input.businessId, input.instanceId);
      console.log(`[Orchestrator]   → Business: ${businessContext.business?.name || 'unknown'}`);
      console.log(`[Orchestrator]   → Products: ${businessContext.products.length}, Zones: ${businessContext.deliveryZones.length}`);
      console.log(`[Orchestrator]   → Objective: ${businessContext.businessObjective}, HasAppointments: ${businessContext.hasAppointments}`);

      currentStep = 'loadConversationContext';
      console.log(`[Orchestrator] [3/7] ${currentStep}`);
      const [convContextPartial, historyMessages] = await Promise.all([
        loadConversationContext(input.businessId, input.contactPhone, input.instanceId),
        loadConversationHistory(input.businessId, input.contactPhone, input.instanceId, 20)
      ]);
      console.log(`[Orchestrator]   → Contact: ${convContextPartial.contact?.name ? 'found' : 'NEW CONTACT'}`);
      console.log(`[Orchestrator]   → Active Order: ${convContextPartial.existingOrder?.id?.slice(0, 8) || 'NONE'}`);
      console.log(`[Orchestrator]   → History from DB: ${historyMessages.length} messages`);
      
      if (historyMessages.length === 0) {
        console.log(`[Orchestrator]   ⚠ WARNING: No history - treating as NEW conversation`);
      }
      
      const allMessages = combineMessages(historyMessages, input.messages);
      console.log(`[Orchestrator]   → Combined messages: history(${historyMessages.length}) + new(${input.messages.length}) = ${allMessages.length}`);
      
      const conversationContext: ConversationContext = {
        ...convContextPartial,
        messages: allMessages
      };

      currentStep = 'buildContext';
      console.log(`[Orchestrator] [4/7] ${currentStep}`);
      const contextBuilder = new ContextBuilder(
        businessContext,
        conversationContext,
        input.triggerContext || {}
      );
      
      const builtContext = await contextBuilder.build();
      console.log(`[Orchestrator]   → System prompt: ${builtContext.systemPrompt?.length || 0} chars`);
      console.log(`[Orchestrator]   → Conversation messages: ${builtContext.conversationMessages?.length || 0}`);
      console.log(`[Orchestrator]   → Current funnel stage: ${builtContext.metadata.currentStage || 'NONE'}`);
      console.log(`[Orchestrator]   → Allowed tools by stage: ${builtContext.allowedTools.length > 0 ? builtContext.allowedTools.join(', ') : 'ALL (no restriction)'}`);

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
      console.log(`[Orchestrator] [5/7] ${currentStep}`);
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
        
        console.log(`[Orchestrator]   → Stage allows actions: ${stageAllowsActions}`);
        
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
      
      console.log(`[Orchestrator]   → LLM1 receives tools: ${openaiTools.length > 0 ? openaiTools.map((t: any) => t.function?.name).join(', ') : 'NONE (conversation only)'}`);
      console.log(`[Orchestrator]   → Total registered tools for LLM2 delegate: ${allOpenaiTools.length}`);

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
      console.log(`[Orchestrator] ═══════════════════════════════════════════════════════`);
      console.log(`[Orchestrator] [6/7] LLM1 CALL SETUP`);
      console.log(`[Orchestrator]   📋 Context: businessId=${input.businessId?.slice(0, 8)}..., instanceId=${input.instanceId?.slice(0, 8) || 'NONE'}`);
      console.log(`[Orchestrator]   📦 Products loaded: ${businessContext.products.length}, Zones: ${businessContext.deliveryZones.length}`);
      console.log(`[Orchestrator]   💬 Conversation messages: ${builtContext.conversationMessages.length}`);
      console.log(`[Orchestrator]   🔧 Tools for LLM1: ${openaiTools.map((t: any) => t.function?.name).join(', ') || 'NONE'}`);
      console.log(`[Orchestrator]   📝 System prompt length: ${builtContext.systemPrompt.length} chars`);
      if (DEBUG_AGENT) {
        const lastUserMsg = builtContext.conversationMessages.filter(m => m.role === 'user').pop();
        console.log(`[Orchestrator]   💬 Last user message: "${redactForLog(lastUserMsg?.content, 100)}"`);
      }
      console.log(`[Orchestrator]   🤖 Model: ${llmConfig.model}, Temp: ${llmConfig.temperature}`);
      
      const llm1StartTime = Date.now();
      let response = await this.llmProvider.chat(llmMessages, llmConfig, openaiTools);
      llmCalls++;
      
      const llm1Duration = Date.now() - llm1StartTime;
      console.log(`[Orchestrator] ───────────────────────────────────────────────────`);
      console.log(`[Orchestrator]   ⚡ LLM1 RESPONSE (${llm1Duration}ms)`);
      console.log(`[Orchestrator]   📤 Finish reason: ${response.finishReason}`);
      console.log(`[Orchestrator]   🔧 Tool calls requested: ${response.toolCalls?.length || 0}`);
      if (response.toolCalls?.length) {
        console.log(`[Orchestrator]   📌 Tools: ${response.toolCalls.map(t => t.name).join(', ')}`);
        for (const tc of response.toolCalls) {
          console.log(`[Orchestrator]   └─ ${tc.name}: ${redactForLog(tc.arguments, 200)}`);
        }
      }
      if (response.content && !response.toolCalls?.length) {
        console.log(`[Orchestrator]   💬 LLM1 decided to respond directly (no tool call)`);
        console.log(`[Orchestrator]   📝 Response preview: "${redactForLog(response.content, 100)}"`);
      }
      
      if (response.usage) {
        totalTokens.prompt += response.usage.promptTokens;
        totalTokens.completion += response.usage.completionTokens;
        totalTokens.total += response.usage.totalTokens;
      }

      let toolCallCount = 0;
      while (response.finishReason === 'tool_calls' && response.toolCalls && toolCallCount < this.config.maxToolCalls!) {
        currentStep = `toolExecution_${toolCallCount}`;
        console.log(`[Orchestrator] [7/7] TOOL LOOP iteration ${toolCallCount + 1}/${this.config.maxToolCalls}`);
        console.log(`[Orchestrator]   → Processing ${response.toolCalls.length} tool call(s)`);

        const toolResults: LLMMessage[] = [];

        for (const toolCall of response.toolCalls) {
          console.log(`[Orchestrator]   🔧 TOOL: ${toolCall.name}`);
          if (DEBUG_AGENT) {
            console.log(`[Orchestrator]   📥 Args: ${redactForLog(toolCall.arguments)}`);
          }
          
          const toolStartTime = Date.now();
          const result = await toolRegistry.executeTool(
            toolCall.name,
            toolCall.arguments,
            toolContext
          );
          const toolDuration = Date.now() - toolStartTime;
          
          console.log(`[Orchestrator]   📤 Result (${toolDuration}ms): ${result.success ? '✓ SUCCESS' : '✗ FAILED'}`);
          if (DEBUG_AGENT) {
            console.log(`[Orchestrator]   📄 Output: ${redactForLog(result.content)}`);
          }
          
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

        console.log(`[Orchestrator]   → Calling LLM again after tool results...`);
        const llmLoopStart = Date.now();
        response = await this.llmProvider.chat(llmMessages, llmConfig, openaiTools);
        llmCalls++;
        console.log(`[Orchestrator]   → LLM response (${Date.now() - llmLoopStart}ms): finish=${response.finishReason}, moreTools=${response.toolCalls?.length || 0}`);
        
        if (response.usage) {
          totalTokens.prompt += response.usage.promptTokens;
          totalTokens.completion += response.usage.completionTokens;
          totalTokens.total += response.usage.totalTokens;
        }

        toolCallCount++;
      }

      const finalResponse = response.content || 'Lo siento, no pude generar una respuesta.';

      const processingTimeMs = Date.now() - startTime;
      console.log(`[Orchestrator] ═══════════════════════════════════════════════════════`);
      console.log(`[Orchestrator] ✓ V3 PROCESS COMPLETED`);
      console.log(`[Orchestrator]   → Duration: ${processingTimeMs}ms`);
      console.log(`[Orchestrator]   → LLM calls: ${llmCalls}`);
      console.log(`[Orchestrator]   → Tools executed: ${toolsExecuted.length} - ${toolsExecuted.map(t => t.name).join(', ') || 'none'}`);
      console.log(`[Orchestrator]   → Tokens: prompt=${totalTokens.prompt}, completion=${totalTokens.completion}`);
      console.log(`[Orchestrator] ═══════════════════════════════════════════════════════`);

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

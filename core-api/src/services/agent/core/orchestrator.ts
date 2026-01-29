import { ToolContext, ToolAvailabilityContext, ToolDefinitionContext, LLMMessage, LLMConfig, OpenAIToolFormat } from './types.js';
import { toolRegistry } from './toolRegistry.js';
import { LLMFactory, ILLMProvider } from './llmAdapter.js';
import { ContextBuilder, BusinessContext, ConversationContext, TriggerContext, loadBusinessContext, loadConversationContext } from '../prompts/contextBuilder.js';
import { loadCustomToolsForBusiness } from '../tools/customToolAdapter.js';
import { registerAllNativeTools } from '../tools/index.js';

export interface OrchestratorConfig {
  maxToolCalls?: number;
  llmProvider?: 'openai' | 'openrouter';
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
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
    console.log(`[Orchestrator] Processing message for ${input.contactPhone}`);

    const toolsExecuted: OrchestratorOutput['toolsExecuted'] = [];
    let totalTokens = { prompt: 0, completion: 0, total: 0 };
    let llmCalls = 0;

    try {
      await loadCustomToolsForBusiness(input.businessId);

      const businessContext = await loadBusinessContext(input.businessId, input.instanceId);
      const convContextPartial = await loadConversationContext(input.businessId, input.contactPhone, input.instanceId);
      
      const conversationContext: ConversationContext = {
        ...convContextPartial,
        messages: input.messages
      };

      const contextBuilder = new ContextBuilder(
        businessContext,
        conversationContext,
        input.triggerContext || {}
      );
      
      const builtContext = await contextBuilder.build();

      const availabilityContext: ToolAvailabilityContext = {
        businessId: input.businessId,
        instanceId: input.instanceId,
        hasActiveOrder: !!conversationContext.existingOrder,
        hasProducts: businessContext.products.length > 0,
        hasZones: businessContext.deliveryZones.length > 0,
        hasAppointments: businessContext.hasAppointments,
        businessObjective: businessContext.businessObjective
      };

      const definitionContext: ToolDefinitionContext = {
        hasActiveOrder: !!conversationContext.existingOrder,
        hasProducts: businessContext.products.length > 0,
        hasZones: businessContext.deliveryZones.length > 0,
        hasAppointments: businessContext.hasAppointments,
        zoneDescriptions: businessContext.deliveryZones.map(z => z.name).join(', '),
        businessObjective: businessContext.businessObjective
      };

      const openaiTools = toolRegistry.getOpenAITools(availabilityContext, definitionContext);
      console.log(`[Orchestrator] Available tools: ${openaiTools.length}`);

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

      let response = await this.llmProvider.chat(llmMessages, llmConfig, openaiTools);
      llmCalls++;
      
      if (response.usage) {
        totalTokens.prompt += response.usage.promptTokens;
        totalTokens.completion += response.usage.completionTokens;
        totalTokens.total += response.usage.totalTokens;
      }

      let toolCallCount = 0;
      while (response.finishReason === 'tool_calls' && response.toolCalls && toolCallCount < this.config.maxToolCalls!) {
        console.log(`[Orchestrator] Processing ${response.toolCalls.length} tool calls`);

        const toolResults: LLMMessage[] = [];

        for (const toolCall of response.toolCalls) {
          console.log(`[Orchestrator] Executing tool: ${toolCall.name}`);
          
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
      console.error('[Orchestrator] Error:', error);
      
      return {
        response: 'Lo siento, hubo un error procesando tu mensaje. Por favor intenta de nuevo.',
        toolsExecuted,
        tokensUsed: totalTokens,
        metadata: {
          model: this.config.model!,
          llmCalls,
          processingTimeMs: Date.now() - startTime
        }
      };
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
  const orchestrator = getOrchestrator(input.config);
  return orchestrator.process(input);
}

import OpenAI from 'openai';
import { LLMMessage, LLMResponse, LLMConfig, OpenAIToolFormat } from './types.js';

const LLM_TIMEOUT_MS = 30000;
const LLM_MAX_RETRIES = 3;
const LLM_RETRY_BASE_DELAY_MS = 5000;

function isRetryableError(error: any): boolean {
  if (error?.status === 429) return true;
  if (error?.status >= 500 && error?.status < 600) return true;
  if (error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNREFUSED') return true;
  if (error?.code === 'UND_ERR_CONNECT_TIMEOUT' || error?.code === 'UND_ERR_SOCKET') return true;
  if (error?.message?.includes('timeout') || error?.message?.includes('TIMEOUT')) return true;
  if (error?.message?.includes('rate_limit') || error?.message?.includes('Rate limit')) return true;
  if (error?.message?.includes('overloaded') || error?.message?.includes('capacity')) return true;
  if (error?.type === 'server_error' || error?.type === 'rate_limit_error') return true;
  return false;
}

async function withRetryAndTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  label: string,
  traceId?: string
): Promise<T> {
  const prefix = traceId ? `[${label}][TRACE:${traceId}]` : `[${label}]`;
  let lastError: any;

  for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    try {
      const result = await fn(controller.signal);
      clearTimeout(timeoutId);
      if (attempt > 1) {
        console.log(`${prefix} Succeeded on attempt ${attempt}/${LLM_MAX_RETRIES}`);
      }
      return result;
    } catch (error: any) {
      clearTimeout(timeoutId);
      lastError = error;

      const isAbort = error?.name === 'AbortError' || controller.signal.aborted;
      const errorType = isAbort ? 'TIMEOUT' : (error?.status || error?.code || 'UNKNOWN');
      const errorMsg = isAbort ? `Request timed out after ${LLM_TIMEOUT_MS}ms` : (error?.message || 'Unknown error');

      if (attempt < LLM_MAX_RETRIES && (isAbort || isRetryableError(error))) {
        const delayMs = LLM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`${prefix} ⚠️ RETRY ${attempt}/${LLM_MAX_RETRIES} - ${errorType}: ${errorMsg} - waiting ${delayMs}ms`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      console.error(`${prefix} ✗ FAILED after ${attempt} attempt(s) - ${errorType}: ${errorMsg}`);
      throw error;
    }
  }

  throw lastError;
}

export interface ILLMProvider {
  readonly name: string;
  
  chat(
    messages: LLMMessage[],
    config: LLMConfig,
    tools?: OpenAIToolFormat[],
    traceId?: string
  ): Promise<LLMResponse>;
  
  isConfigured(): boolean;
}

export class OpenAIAdapter implements ILLMProvider {
  readonly name = 'openai';
  private client: OpenAI | null = null;
  private apiKey: string | undefined;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY;
    if (this.apiKey) {
      this.client = new OpenAI({ apiKey: this.apiKey });
    }
  }

  isConfigured(): boolean {
    return !!this.client;
  }

  async chat(
    messages: LLMMessage[],
    config: LLMConfig,
    tools?: OpenAIToolFormat[],
    traceId?: string
  ): Promise<LLMResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not configured');
    }

    const openaiMessages = messages.map(msg => this.toOpenAIMessage(msg));

    const params: OpenAI.Chat.ChatCompletionCreateParams = {
      model: config.model,
      messages: openaiMessages,
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 2000,
    };

    if (tools && tools.length > 0) {
      params.tools = tools;
      params.tool_choice = 'auto';
    }

    const prefix = traceId ? `[OpenAIAdapter][TRACE:${traceId}]` : `[OpenAIAdapter]`;
    console.log(`${prefix} Calling ${config.model} with ${messages.length} messages, ${tools?.length || 0} tools`);

    const client = this.client;
    const startTime = Date.now();

    const response = await withRetryAndTimeout(
      async (signal: AbortSignal) => {
        return await client.chat.completions.create(params, { signal, timeout: LLM_TIMEOUT_MS });
      },
      'OpenAIAdapter',
      traceId
    );

    const duration = Date.now() - startTime;
    const choice = response.choices[0];

    const result: LLMResponse = {
      content: choice.message.content,
      finishReason: this.mapFinishReason(choice.finish_reason),
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens
      } : undefined
    };

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      result.toolCalls = choice.message.tool_calls
        .filter((tc: any) => tc.type === 'function' && tc.function)
        .map((tc: any) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: this.safeParseJSON(tc.function.arguments)
        }));
    }

    console.log(`${prefix} Response (${duration}ms): ${result.finishReason}, tools: ${result.toolCalls?.length || 0}, tokens: ${result.usage?.totalTokens}`);

    return result;
  }

  private toOpenAIMessage(msg: LLMMessage): OpenAI.Chat.ChatCompletionMessageParam {
    switch (msg.role) {
      case 'system':
        return { role: 'system', content: msg.content };
      case 'user':
        return { role: 'user', content: msg.content };
      case 'assistant':
        if (msg.tool_calls) {
          return { role: 'assistant', content: msg.content, tool_calls: msg.tool_calls };
        }
        return { role: 'assistant', content: msg.content };
      case 'tool':
        return { role: 'tool', content: msg.content, tool_call_id: msg.tool_call_id! };
      default:
        return { role: 'user', content: msg.content };
    }
  }

  private mapFinishReason(reason: string | null): LLMResponse['finishReason'] {
    switch (reason) {
      case 'stop': return 'stop';
      case 'tool_calls': return 'tool_calls';
      case 'length': return 'length';
      case 'content_filter': return 'content_filter';
      default: return 'stop';
    }
  }

  private safeParseJSON(str: string): Record<string, any> {
    try {
      return JSON.parse(str);
    } catch {
      return {};
    }
  }
}

export class OpenRouterAdapter implements ILLMProvider {
  readonly name = 'openrouter';
  private client: OpenAI | null = null;
  private apiKey: string | undefined;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.OPENROUTER_API_KEY;
    if (this.apiKey) {
      this.client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: 'https://openrouter.ai/api/v1'
      });
    }
  }

  isConfigured(): boolean {
    return !!this.client;
  }

  async chat(
    messages: LLMMessage[],
    config: LLMConfig,
    tools?: OpenAIToolFormat[],
    traceId?: string
  ): Promise<LLMResponse> {
    if (!this.client) {
      throw new Error('OpenRouter client not configured');
    }

    const openaiMessages = messages.map(msg => this.toOpenAIMessage(msg));

    const params: OpenAI.Chat.ChatCompletionCreateParams = {
      model: config.model,
      messages: openaiMessages,
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 2000,
    };

    if (tools && tools.length > 0) {
      params.tools = tools;
      params.tool_choice = 'auto';
    }

    const prefix = traceId ? `[OpenRouterAdapter][TRACE:${traceId}]` : `[OpenRouterAdapter]`;
    console.log(`${prefix} Calling ${config.model} with ${messages.length} messages`);

    const client = this.client;
    const startTime = Date.now();

    const response = await withRetryAndTimeout(
      async (signal: AbortSignal) => {
        return await client.chat.completions.create(params, { signal, timeout: LLM_TIMEOUT_MS });
      },
      'OpenRouterAdapter',
      traceId
    );

    const duration = Date.now() - startTime;
    const choice = response.choices[0];

    const result: LLMResponse = {
      content: choice.message.content,
      finishReason: this.mapFinishReason(choice.finish_reason),
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens
      } : undefined
    };

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      result.toolCalls = choice.message.tool_calls
        .filter((tc: any) => tc.type === 'function' && tc.function)
        .map((tc: any) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: this.safeParseJSON(tc.function.arguments)
        }));
    }

    console.log(`${prefix} Response (${duration}ms): ${result.finishReason}, tools: ${result.toolCalls?.length || 0}, tokens: ${result.usage?.totalTokens}`);

    return result;
  }

  private toOpenAIMessage(msg: LLMMessage): OpenAI.Chat.ChatCompletionMessageParam {
    switch (msg.role) {
      case 'system':
        return { role: 'system', content: msg.content };
      case 'user':
        return { role: 'user', content: msg.content };
      case 'assistant':
        if (msg.tool_calls) {
          return { role: 'assistant', content: msg.content, tool_calls: msg.tool_calls };
        }
        return { role: 'assistant', content: msg.content };
      case 'tool':
        return { role: 'tool', content: msg.content, tool_call_id: msg.tool_call_id! };
      default:
        return { role: 'user', content: msg.content };
    }
  }

  private mapFinishReason(reason: string | null): LLMResponse['finishReason'] {
    switch (reason) {
      case 'stop': return 'stop';
      case 'tool_calls': return 'tool_calls';
      case 'length': return 'length';
      case 'content_filter': return 'content_filter';
      default: return 'stop';
    }
  }

  private safeParseJSON(str: string): Record<string, any> {
    try {
      return JSON.parse(str);
    } catch {
      return {};
    }
  }
}

export type LLMProviderType = 'openai' | 'openrouter' | 'gemini';

const OPENROUTER_MODEL_MAP: Record<string, string> = {
  'gpt-4o': 'openai/gpt-4o',
  'gpt-4o-mini': 'openai/gpt-4o-mini',
  'gpt-4.1': 'openai/gpt-4.1',
  'gpt-4.1-mini': 'openai/gpt-4.1-mini',
  'gpt-4.1-nano': 'openai/gpt-4.1-nano',
  'gpt-4-turbo': 'openai/gpt-4-turbo',
  'gpt-3.5-turbo': 'openai/gpt-3.5-turbo',
  'gemini-2.5-flash': 'google/gemini-2.5-flash-preview',
  'gemini-2.5-pro': 'google/gemini-2.5-pro-preview',
  'gemini-2.0-flash': 'google/gemini-2.0-flash-001',
  'gemini-1.5-pro': 'google/gemini-pro-1.5',
  'gemini-1.5-flash': 'google/gemini-flash-1.5',
};

function mapModelToOpenRouter(model: string): string {
  if (model.includes('/')) return model;
  if (OPENROUTER_MODEL_MAP[model]) return OPENROUTER_MODEL_MAP[model];
  if (model.startsWith('gpt-')) return `openai/${model}`;
  if (model.startsWith('gemini-')) return `google/${model}`;
  if (model.startsWith('claude-')) return `anthropic/${model}`;
  return model;
}

export class FallbackLLMProvider implements ILLMProvider {
  readonly name: string;
  private primary: ILLMProvider;
  private fallback: OpenRouterAdapter;

  constructor(primary: ILLMProvider, fallback: OpenRouterAdapter) {
    this.primary = primary;
    this.fallback = fallback;
    this.name = `${primary.name}+openrouter-fallback`;
  }

  isConfigured(): boolean {
    return this.primary.isConfigured();
  }

  async chat(
    messages: LLMMessage[],
    config: LLMConfig,
    tools?: OpenAIToolFormat[],
    traceId?: string
  ): Promise<LLMResponse> {
    const prefix = traceId ? `[Fallback][TRACE:${traceId}]` : `[Fallback]`;

    try {
      return await this.primary.chat(messages, config, tools, traceId);
    } catch (primaryError: any) {
      if (!this.fallback.isConfigured()) {
        console.error(`${prefix} ${this.primary.name} failed and OpenRouter fallback not configured - re-throwing`);
        throw primaryError;
      }

      const errorType = primaryError?.status || primaryError?.code || 'UNKNOWN';
      const errorMsg = primaryError?.message || 'Unknown error';
      console.warn(`${prefix} ⚠️ PRIMARY FAILED (${this.primary.name}) - ${errorType}: ${errorMsg}`);

      const openRouterModel = mapModelToOpenRouter(config.model);
      console.warn(`${prefix} → FALLING BACK to OpenRouter with model: ${openRouterModel} (original: ${config.model})`);

      const fallbackConfig: LLMConfig = {
        ...config,
        model: openRouterModel
      };

      try {
        const result = await this.fallback.chat(messages, fallbackConfig, tools, traceId);
        console.log(`${prefix} ✓ OpenRouter fallback SUCCEEDED for model ${openRouterModel}`);
        return result;
      } catch (fallbackError: any) {
        const fbErrorType = fallbackError?.status || fallbackError?.code || 'UNKNOWN';
        const fbErrorMsg = fallbackError?.message || 'Unknown error';
        console.error(`${prefix} ✗ OpenRouter fallback ALSO FAILED - ${fbErrorType}: ${fbErrorMsg}`);
        console.error(`${prefix} ✗ Both ${this.primary.name} and OpenRouter failed for model ${config.model}. Throwing original error.`);
        throw primaryError;
      }
    }
  }
}

export class LLMFactory {
  private static providers: Map<string, ILLMProvider> = new Map();
  private static openRouterFallback: OpenRouterAdapter | null = null;

  private static getOpenRouterFallback(): OpenRouterAdapter {
    if (!this.openRouterFallback) {
      this.openRouterFallback = new OpenRouterAdapter();
    }
    return this.openRouterFallback;
  }

  static getProvider(type: LLMProviderType = 'openai'): ILLMProvider {
    if (type === 'openrouter') {
      let provider = this.providers.get('openrouter-direct');
      if (!provider) {
        provider = new OpenRouterAdapter();
        this.providers.set('openrouter-direct', provider);
      }
      return provider;
    }

    const cacheKey = `${type}-with-fallback`;
    let provider = this.providers.get(cacheKey);

    if (!provider) {
      let primaryProvider: ILLMProvider;
      switch (type) {
        case 'openai':
          primaryProvider = new OpenAIAdapter();
          break;
        case 'gemini':
          console.warn(`[LLMFactory] Gemini direct adapter not yet implemented - routing through OpenRouter`);
          const geminiViaRouter = this.getOpenRouterFallback();
          if (geminiViaRouter.isConfigured()) {
            this.providers.set(cacheKey, geminiViaRouter);
            return geminiViaRouter;
          }
          throw new Error('Gemini provider requires OPENROUTER_API_KEY (Gemini is served via OpenRouter)');
        default:
          primaryProvider = new OpenAIAdapter();
      }

      const fallback = this.getOpenRouterFallback();
      if (fallback.isConfigured()) {
        provider = new FallbackLLMProvider(primaryProvider, fallback);
        console.log(`[LLMFactory] Created ${type} provider with OpenRouter fallback`);
      } else {
        provider = primaryProvider;
        console.log(`[LLMFactory] Created ${type} provider WITHOUT fallback (OPENROUTER_API_KEY not set)`);
      }

      this.providers.set(cacheKey, provider);
    }

    return provider;
  }

  static getDefaultProvider(): ILLMProvider {
    const openai = this.getProvider('openai');
    if (openai.isConfigured()) return openai;
    
    const openrouter = this.getProvider('openrouter');
    if (openrouter.isConfigured()) return openrouter;
    
    throw new Error('No LLM provider configured. Set OPENAI_API_KEY or OPENROUTER_API_KEY.');
  }

  static isAnyProviderConfigured(): boolean {
    const openaiAdapter = new OpenAIAdapter();
    const openrouterAdapter = new OpenRouterAdapter();
    return openaiAdapter.isConfigured() || openrouterAdapter.isConfigured();
  }

  static resetProviders(): void {
    this.providers.clear();
    this.openRouterFallback = null;
  }
}

import OpenAI from 'openai';
import { LLMMessage, LLMResponse, LLMConfig, OpenAIToolFormat } from './types.js';

export interface ILLMProvider {
  readonly name: string;
  
  chat(
    messages: LLMMessage[],
    config: LLMConfig,
    tools?: OpenAIToolFormat[]
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
    tools?: OpenAIToolFormat[]
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

    console.log(`[OpenAIAdapter] Calling ${config.model} with ${messages.length} messages, ${tools?.length || 0} tools`);

    const response = await this.client.chat.completions.create(params);
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

    console.log(`[OpenAIAdapter] Response: ${result.finishReason}, tools: ${result.toolCalls?.length || 0}, tokens: ${result.usage?.totalTokens}`);

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
    tools?: OpenAIToolFormat[]
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

    console.log(`[OpenRouterAdapter] Calling ${config.model} with ${messages.length} messages`);

    const response = await this.client.chat.completions.create(params);
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

export class LLMFactory {
  private static providers: Map<LLMProviderType, ILLMProvider> = new Map();

  static getProvider(type: LLMProviderType = 'openai'): ILLMProvider {
    let provider = this.providers.get(type);
    
    if (!provider) {
      switch (type) {
        case 'openai':
          provider = new OpenAIAdapter();
          break;
        case 'openrouter':
          provider = new OpenRouterAdapter();
          break;
        default:
          provider = new OpenAIAdapter();
      }
      this.providers.set(type, provider);
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
    return this.getProvider('openai').isConfigured() || this.getProvider('openrouter').isConfigured();
  }
}

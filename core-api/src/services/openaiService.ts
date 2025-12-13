import OpenAI from 'openai';
import prisma from './prisma.js';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_MODEL = 'gpt-4.1-mini';

const PRICING_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-4.1': { input: 0.002, output: 0.008 },
  'gpt-4.1-mini': { input: 0.0004, output: 0.0016 },
  'gpt-4.1-nano': { input: 0.0001, output: 0.0004 },
  'gpt-4o': { input: 0.005, output: 0.015 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'gpt-4': { input: 0.03, output: 0.06 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  'gpt-5': { input: 0.00125, output: 0.01 },
  'gpt-5-mini': { input: 0.00025, output: 0.002 },
  'gpt-5-nano': { input: 0.00005, output: 0.0004 },
  'gpt-5.2': { input: 0.00175, output: 0.014 },
  'gpt-5.2-pro': { input: 0.021, output: 0.168 }
};

export const AVAILABLE_MODELS = [
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', tier: 'budget', family: 'gpt-4' },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', tier: 'standard', family: 'gpt-4' },
  { id: 'gpt-4.1', name: 'GPT-4.1', tier: 'premium', family: 'gpt-4' },
  { id: 'gpt-5-nano', name: 'GPT-5 Nano', tier: 'budget', family: 'gpt-5' },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', tier: 'standard', family: 'gpt-5' },
  { id: 'gpt-5', name: 'GPT-5', tier: 'premium', family: 'gpt-5' },
  { id: 'gpt-5.2', name: 'GPT-5.2', tier: 'flagship', family: 'gpt-5' },
  { id: 'gpt-5.2-pro', name: 'GPT-5.2 Pro', tier: 'enterprise', family: 'gpt-5' }
];

export const REASONING_EFFORTS: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];

let cachedSettings: {
  defaultModelV1: string;
  defaultModelV2: string;
  defaultReasoningV1: ReasoningEffort;
  defaultReasoningV2: ReasoningEffort;
  vendorModelV2: string;
  observerModelV2: string;
  refinerModelV2: string;
  availableModels: string[];
  maxTokensPerRequest: number;
  enableGPT5Features: boolean;
} | null = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 60000;

export async function getPlatformSettings() {
  const now = Date.now();
  if (cachedSettings && (now - settingsCacheTime) < SETTINGS_CACHE_TTL) {
    return cachedSettings;
  }

  let settings = await prisma.platformSettings.findUnique({
    where: { id: 'default' }
  });

  if (!settings) {
    settings = await prisma.platformSettings.create({
      data: { id: 'default' }
    });
  }

  cachedSettings = {
    defaultModelV1: settings.defaultModelV1,
    defaultModelV2: settings.defaultModelV2,
    defaultReasoningV1: settings.defaultReasoningV1,
    defaultReasoningV2: settings.defaultReasoningV2,
    vendorModelV2: settings.vendorModelV2,
    observerModelV2: settings.observerModelV2,
    refinerModelV2: settings.refinerModelV2,
    availableModels: settings.availableModels,
    maxTokensPerRequest: settings.maxTokensPerRequest,
    enableGPT5Features: settings.enableGPT5Features
  };
  settingsCacheTime = now;

  return cachedSettings;
}

export async function updatePlatformSettings(updates: {
  defaultModelV1?: string;
  defaultModelV2?: string;
  defaultReasoningV1?: ReasoningEffort;
  defaultReasoningV2?: ReasoningEffort;
  vendorModelV2?: string;
  observerModelV2?: string;
  refinerModelV2?: string;
  availableModels?: string[];
  maxTokensPerRequest?: number;
  enableGPT5Features?: boolean;
  updatedBy?: string;
}) {
  const settings = await prisma.platformSettings.upsert({
    where: { id: 'default' },
    update: updates,
    create: { id: 'default', ...updates }
  });

  cachedSettings = null;
  settingsCacheTime = 0;

  return settings;
}

export function clearSettingsCache() {
  cachedSettings = null;
  settingsCacheTime = 0;
}

function calculateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICING_PER_1K_TOKENS[model] || PRICING_PER_1K_TOKENS['gpt-4.1-mini'];
  const inputCost = (promptTokens / 1000) * pricing.input;
  const outputCost = (completionTokens / 1000) * pricing.output;
  return parseFloat((inputCost + outputCost).toFixed(6));
}

export function isOpenAIConfigured(): boolean {
  return !!OPENAI_API_KEY;
}

export function getDefaultModel(): string {
  return DEFAULT_MODEL;
}

export async function getModelForAgent(agentVersion: 'v1' | 'v2', businessModel?: string | null): Promise<{
  model: string;
  reasoningEffort: ReasoningEffort;
}> {
  if (businessModel) {
    return { model: businessModel, reasoningEffort: 'none' };
  }
  
  try {
    const settings = await getPlatformSettings();
    if (agentVersion === 'v2') {
      return {
        model: settings.defaultModelV2,
        reasoningEffort: settings.defaultReasoningV2
      };
    }
    return {
      model: settings.defaultModelV1,
      reasoningEffort: settings.defaultReasoningV1
    };
  } catch (error) {
    console.error('Failed to get platform settings, using defaults:', error);
    return { model: DEFAULT_MODEL, reasoningEffort: 'none' };
  }
}

let openaiInstance: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!OPENAI_API_KEY) {
    throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY environment variable.');
  }
  
  if (!openaiInstance) {
    openaiInstance = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  
  return openaiInstance;
}

export interface TokenUsageData {
  businessId: string;
  userId?: string;
  feature: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export async function logTokenUsage(data: TokenUsageData): Promise<void> {
  try {
    const costUsd = calculateCost(data.model, data.promptTokens, data.completionTokens);
    
    await prisma.tokenUsage.create({
      data: {
        businessId: data.businessId,
        userId: data.userId,
        feature: data.feature,
        model: data.model,
        promptTokens: data.promptTokens,
        completionTokens: data.completionTokens,
        totalTokens: data.totalTokens,
        costUsd
      }
    });
  } catch (error) {
    console.error('Failed to log token usage:', error);
  }
}

function isGPT5Model(model: string): boolean {
  return model.startsWith('gpt-5') || model.startsWith('o1') || model.startsWith('o3');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallOpenAIOptions {
  model: string;
  messages: ChatMessage[];
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  temperature?: number;
  maxHistoryTokens?: number;
  context: {
    businessId: string;
    userId?: string;
    feature: string;
  };
}

export interface CallOpenAIResult {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  reasoningUsed: boolean;
}

function optimizeMessages(
  messages: ChatMessage[],
  maxHistoryTokens: number
): ChatMessage[] {
  if (messages.length === 0) return messages;
  
  const systemMessages = messages.filter(m => m.role === 'system');
  const conversationMessages = messages.filter(m => m.role !== 'system');
  
  const systemTokens = systemMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const availableForHistory = Math.max(maxHistoryTokens - systemTokens, 500);
  
  const optimizedConversation: ChatMessage[] = [];
  let usedTokens = 0;
  
  for (let i = conversationMessages.length - 1; i >= 0; i--) {
    const msg = conversationMessages[i];
    const msgTokens = estimateTokens(msg.content);
    
    if (usedTokens + msgTokens <= availableForHistory) {
      optimizedConversation.unshift(msg);
      usedTokens += msgTokens;
    } else {
      break;
    }
  }
  
  return [...systemMessages, ...optimizedConversation];
}

export async function callOpenAI(options: CallOpenAIOptions): Promise<CallOpenAIResult> {
  const client = getOpenAIClient();
  const { model, reasoningEffort = 'none', maxTokens = 1000, temperature = 0.7, context } = options;
  
  const maxHistoryTokens = options.maxHistoryTokens || 3000;
  const optimizedMessages = optimizeMessages(options.messages, maxHistoryTokens);
  
  const useResponsesAPI = isGPT5Model(model);
  const includeReasoning = useResponsesAPI && reasoningEffort !== 'none';
  
  let content = '';
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
  
  if (useResponsesAPI) {
    const responseParams: any = {
      model,
      input: optimizedMessages.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content
      })),
      max_output_tokens: maxTokens
    };
    
    if (includeReasoning) {
      const reasoningMap: Record<ReasoningEffort, string> = {
        'none': 'low',
        'low': 'low',
        'medium': 'medium',
        'high': 'high',
        'xhigh': 'high'
      };
      responseParams.reasoning = { effort: reasoningMap[reasoningEffort] as 'low' | 'medium' | 'high' };
    }
    
    const response = await client.responses.create(responseParams);
    
    const outputItem = response.output?.find((item: any) => item.type === 'message');
    if (outputItem && 'content' in outputItem) {
      const textContent = (outputItem as any).content?.find((c: any) => c.type === 'output_text');
      content = textContent?.text || '';
    }
    
    if (response.usage) {
      usage = {
        promptTokens: response.usage.input_tokens || 0,
        completionTokens: response.usage.output_tokens || 0,
        totalTokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0)
      };
    }
  } else {
    const completion = await client.chat.completions.create({
      model,
      messages: optimizedMessages,
      max_tokens: maxTokens,
      temperature,
      stream: false
    });
    
    content = completion.choices[0]?.message?.content || '';
    
    if (completion.usage) {
      usage = {
        promptTokens: completion.usage.prompt_tokens,
        completionTokens: completion.usage.completion_tokens,
        totalTokens: completion.usage.total_tokens
      };
    }
  }
  
  if (usage) {
    await logTokenUsage({
      businessId: context.businessId,
      userId: context.userId,
      feature: context.feature,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens
    });
  }
  
  return {
    content,
    usage,
    model,
    reasoningUsed: includeReasoning
  };
}

export async function createChatCompletion(
  params: Omit<OpenAI.Chat.ChatCompletionCreateParams, 'stream'>,
  context: { businessId: string; userId?: string; feature: string }
): Promise<OpenAI.Chat.ChatCompletion> {
  const client = getOpenAIClient();
  const model = params.model || DEFAULT_MODEL;
  
  const completion = await client.chat.completions.create({
    ...params,
    model,
    stream: false
  });
  
  if (completion.usage) {
    await logTokenUsage({
      businessId: context.businessId,
      userId: context.userId,
      feature: context.feature,
      model,
      promptTokens: completion.usage.prompt_tokens,
      completionTokens: completion.usage.completion_tokens,
      totalTokens: completion.usage.total_tokens
    });
  }
  
  return completion;
}

interface TokenStats {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalCost: number;
}

interface FeatureUsage {
  tokens: number;
  cost: number;
}

export async function getTokenUsageStats(businessId: string, options?: {
  startDate?: Date;
  endDate?: Date;
}): Promise<{
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalCost: number;
  byFeature: Array<{ feature: string; tokens: number; cost: number }>;
}> {
  const where: { businessId: string; createdAt?: { gte?: Date; lte?: Date } } = { businessId };
  
  if (options?.startDate || options?.endDate) {
    where.createdAt = {};
    if (options.startDate) where.createdAt.gte = options.startDate;
    if (options.endDate) where.createdAt.lte = options.endDate;
  }
  
  const usage = await prisma.tokenUsage.findMany({ where });
  
  const totals = usage.reduce<TokenStats>((acc, u) => ({
    totalTokens: acc.totalTokens + u.totalTokens,
    promptTokens: acc.promptTokens + u.promptTokens,
    completionTokens: acc.completionTokens + u.completionTokens,
    totalCost: acc.totalCost + u.costUsd
  }), { totalTokens: 0, promptTokens: 0, completionTokens: 0, totalCost: 0 });
  
  const byFeatureMap = usage.reduce<Record<string, FeatureUsage>>((acc, u) => {
    if (!acc[u.feature]) {
      acc[u.feature] = { tokens: 0, cost: 0 };
    }
    acc[u.feature].tokens += u.totalTokens;
    acc[u.feature].cost += u.costUsd;
    return acc;
  }, {});
  
  const byFeature = Object.entries(byFeatureMap).map(([feature, data]) => ({
    feature,
    tokens: data.tokens,
    cost: parseFloat(data.cost.toFixed(6))
  }));
  
  return {
    ...totals,
    totalCost: parseFloat(totals.totalCost.toFixed(6)),
    byFeature
  };
}

export const TRIAL_TOKEN_LIMIT = 100000;

export async function getMonthlyTokenUsageForUser(userId: string): Promise<{
  totalTokens: number;
  limit: number;
  percentUsed: number;
  isOverLimit: boolean;
}> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  
  const usage = await prisma.tokenUsage.aggregate({
    _sum: {
      totalTokens: true
    },
    where: {
      userId,
      createdAt: {
        gte: startOfMonth
      }
    }
  });
  
  const totalTokens = usage._sum.totalTokens || 0;
  const percentUsed = Math.min(100, Math.round((totalTokens / TRIAL_TOKEN_LIMIT) * 100));
  
  return {
    totalTokens,
    limit: TRIAL_TOKEN_LIMIT,
    percentUsed,
    isOverLimit: totalTokens >= TRIAL_TOKEN_LIMIT
  };
}

export async function checkUserTokenLimit(userId: string): Promise<{
  canUseAI: boolean;
  tokensUsed: number;
  tokensRemaining: number;
  message?: string;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { subscriptionStatus: true }
  });
  
  if (!user) {
    return {
      canUseAI: false,
      tokensUsed: 0,
      tokensRemaining: 0,
      message: 'Usuario no encontrado'
    };
  }
  
  if (user.subscriptionStatus === 'ACTIVE') {
    return {
      canUseAI: true,
      tokensUsed: 0,
      tokensRemaining: Infinity
    };
  }
  
  if (user.subscriptionStatus === 'PENDING' || user.subscriptionStatus === 'CANCELED') {
    return {
      canUseAI: false,
      tokensUsed: 0,
      tokensRemaining: 0,
      message: 'Suscribete para usar el agente IA'
    };
  }
  
  const usage = await getMonthlyTokenUsageForUser(userId);
  
  if (usage.isOverLimit) {
    return {
      canUseAI: false,
      tokensUsed: usage.totalTokens,
      tokensRemaining: 0,
      message: 'Has alcanzado tu limite de 100,000 tokens este mes. Suscribete para continuar usando el agente IA sin limites.'
    };
  }
  
  return {
    canUseAI: true,
    tokensUsed: usage.totalTokens,
    tokensRemaining: TRIAL_TOKEN_LIMIT - usage.totalTokens
  };
}

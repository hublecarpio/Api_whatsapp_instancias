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

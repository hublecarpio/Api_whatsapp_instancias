import prisma from './prisma.js';

export type TokenProvider = 'openai' | 'openrouter' | 'gemini';

const PRICING: Record<string, Record<string, { input: number; output: number }>> = {
  openai: {
    'gpt-4.1': { input: 0.002, output: 0.008 },
    'gpt-4.1-mini': { input: 0.0004, output: 0.0016 },
    'gpt-4.1-nano': { input: 0.0001, output: 0.0004 },
    'gpt-4o': { input: 0.0025, output: 0.01 },
    'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
    'gpt-4-turbo': { input: 0.01, output: 0.03 },
    'gpt-4': { input: 0.03, output: 0.06 },
    'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
    'text-embedding-3-small': { input: 0.00002, output: 0 },
    'text-embedding-3-large': { input: 0.00013, output: 0 },
    default: { input: 0.0005, output: 0.002 }
  },
  openrouter: {
    'openai/gpt-4.1': { input: 0.002, output: 0.008 },
    'openai/gpt-4.1-mini': { input: 0.0004, output: 0.0016 },
    'openai/gpt-4.1-nano': { input: 0.0001, output: 0.0004 },
    'openai/gpt-4o': { input: 0.0025, output: 0.01 },
    'openai/gpt-4o-mini': { input: 0.00015, output: 0.0006 },
    'google/gemini-2.5-flash-preview': { input: 0.00015, output: 0.0006 },
    'google/gemini-2.5-flash-preview:thinking': { input: 0.00015, output: 0.0035 },
    'google/gemini-2.5-pro': { input: 0.00125, output: 0.01 },
    'google/gemini-3-flash-preview': { input: 0.0002, output: 0.0008 },
    'anthropic/claude-sonnet-4': { input: 0.003, output: 0.015 },
    'anthropic/claude-3.5-sonnet': { input: 0.003, output: 0.015 },
    'anthropic/claude-3.5-haiku': { input: 0.0008, output: 0.004 },
    default: { input: 0.001, output: 0.004 }
  },
  gemini: {
    'gemini-2.5-flash': { input: 0.00015, output: 0.0006 },
    'gemini-2.0-flash': { input: 0.0001, output: 0.0004 },
    'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
    'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
    'gemini-pro': { input: 0.0005, output: 0.0015 },
    default: { input: 0.0001, output: 0.0004 }
  }
};

function calculateCost(
  provider: TokenProvider,
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const providerPricing = PRICING[provider] || PRICING.openai;
  const modelPricing = providerPricing[model] || providerPricing.default;
  
  const inputCost = (promptTokens / 1000) * modelPricing.input;
  const outputCost = (completionTokens / 1000) * modelPricing.output;
  
  return inputCost + outputCost;
}

export async function logTokenUsage(params: {
  businessId: string;
  userId?: string;
  instanceId?: string;
  feature: string;
  provider: TokenProvider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  metadata?: Record<string, any>;
}) {
  try {
    const { businessId, userId, instanceId, feature, provider, model, promptTokens, completionTokens, metadata } = params;
    
    const totalTokens = promptTokens + completionTokens;
    const costUsd = calculateCost(provider, model, promptTokens, completionTokens);
    
    await prisma.tokenUsage.create({
      data: {
        businessId,
        userId,
        instanceId,
        feature,
        provider,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        costUsd,
        metadata: metadata || undefined
      }
    });
    
    console.log(`[TOKEN LOG] ${provider}/${model} - ${feature}: ${totalTokens} tokens, $${costUsd.toFixed(6)}${instanceId ? ` [inst:${instanceId.slice(0, 8)}]` : ''}`);
  } catch (error) {
    console.error('[TOKEN LOG] Failed to log token usage:', error);
  }
}

export function estimateGeminiTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

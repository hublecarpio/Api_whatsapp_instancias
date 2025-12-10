import prisma from './prisma.js';

const PRICING = {
  openai: {
    'gpt-4o': { input: 0.0025, output: 0.01 },
    'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
    'gpt-4-turbo': { input: 0.01, output: 0.03 },
    'gpt-4': { input: 0.03, output: 0.06 },
    'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
    default: { input: 0.0005, output: 0.0015 }
  },
  gemini: {
    'gemini-2.0-flash': { input: 0.0001, output: 0.0004 },
    'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
    'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
    'gemini-pro': { input: 0.0005, output: 0.0015 },
    default: { input: 0.0001, output: 0.0004 }
  }
};

function calculateCost(
  provider: 'openai' | 'gemini',
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const providerPricing = PRICING[provider];
  const modelPricing = providerPricing[model as keyof typeof providerPricing] || providerPricing.default;
  
  const inputCost = (promptTokens / 1000) * modelPricing.input;
  const outputCost = (completionTokens / 1000) * modelPricing.output;
  
  return inputCost + outputCost;
}

export async function logTokenUsage(params: {
  businessId: string;
  userId?: string;
  feature: string;
  provider: 'openai' | 'gemini';
  model: string;
  promptTokens: number;
  completionTokens: number;
}) {
  try {
    const { businessId, userId, feature, provider, model, promptTokens, completionTokens } = params;
    
    const totalTokens = promptTokens + completionTokens;
    const costUsd = calculateCost(provider, model, promptTokens, completionTokens);
    
    await prisma.tokenUsage.create({
      data: {
        businessId,
        userId,
        feature,
        provider,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        costUsd
      }
    });
    
    console.log(`[TOKEN LOG] ${provider}/${model} - ${feature}: ${totalTokens} tokens, $${costUsd.toFixed(6)}`);
  } catch (error) {
    console.error('[TOKEN LOG] Failed to log token usage:', error);
  }
}

export function estimateGeminiTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

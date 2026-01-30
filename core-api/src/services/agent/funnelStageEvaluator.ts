import prisma from '../prisma.js';
import OpenAI from 'openai';
import { getContactStageStatus, setContactStage } from '../funnelStageService.js';
import { getRedisConnection, isRedisAvailable } from '../redis.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EVALUATION_COOLDOWN_MS = 30000;
const LOCK_TTL_SECONDS = 60;
const MAX_MESSAGES = 50;

function compactConversation(messages: Array<{ role: 'user' | 'assistant'; content: string }>): string {
  return messages.map(m => {
    const prefix = m.role === 'user' ? 'C' : 'A';
    const content = m.content
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    return `${prefix}:${content}`;
  }).join('\n');
}

interface EvaluatorInput {
  businessId: string;
  instanceId: string | null;
  contactPhone: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
}

async function acquireLock(key: string): Promise<boolean> {
  if (!isRedisAvailable()) return true;
  try {
    const redis = getRedisConnection();
    const result = await redis.set(key, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    return result === 'OK';
  } catch {
    return true;
  }
}

async function releaseLock(key: string): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    const redis = getRedisConnection();
    await redis.del(key);
  } catch {}
}

async function checkCooldown(key: string): Promise<boolean> {
  if (!isRedisAvailable()) return true;
  try {
    const redis = getRedisConnection();
    const lastRun = await redis.get(key);
    if (lastRun) {
      const elapsed = Date.now() - parseInt(lastRun);
      if (elapsed < EVALUATION_COOLDOWN_MS) {
        return false;
      }
    }
    await redis.set(key, Date.now().toString(), 'EX', Math.ceil(EVALUATION_COOLDOWN_MS / 1000));
    return true;
  } catch {
    return true;
  }
}

export async function evaluateFunnelStageAsync(input: EvaluatorInput): Promise<void> {
  const { businessId, instanceId, contactPhone, conversationHistory } = input;
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  const lockKey = `funnel_eval_lock:${businessId}:${normalizedPhone}`;
  const cooldownKey = `funnel_eval_cooldown:${businessId}:${normalizedPhone}`;
  
  const canProceed = await checkCooldown(cooldownKey);
  if (!canProceed) {
    console.log(`[FunnelEvaluator] Skipping ${normalizedPhone} - cooldown active`);
    return;
  }
  
  const lockAcquired = await acquireLock(lockKey);
  if (!lockAcquired) {
    console.log(`[FunnelEvaluator] Skipping ${normalizedPhone} - another evaluation in progress`);
    return;
  }
  
  try {
    console.log(`[FunnelEvaluator] Starting async evaluation for ${normalizedPhone}`);
    
    const stages = await prisma.funnelStage.findMany({
      where: {
        businessId,
        isActive: true,
        ...(instanceId ? { OR: [{ instanceId }, { instanceId: null }] } : {})
      },
      orderBy: { order: 'asc' }
    });

    if (stages.length === 0) {
      console.log(`[FunnelEvaluator] No funnel stages configured for business ${businessId}`);
      return;
    }

    const currentStatus = await getContactStageStatus(businessId, normalizedPhone);
    
    const currentStageInList = stages.find(s => s.id === currentStatus.currentStage?.id);
    const currentStageName = currentStageInList?.name || stages[0].name;

    const stagesDescription = stages.map((s, i) => {
      let desc = `${i + 1}. ${s.name}`;
      if (s.description) desc += `: ${s.description}`;
      if (s.requiredFieldKeys.length > 0) {
        desc += ` [Requiere: ${s.requiredFieldKeys.join(', ')}]`;
      }
      return desc;
    }).join('\n');

    const recentConversation = compactConversation(conversationHistory.slice(-50));

    const prompt = `Evaluador de etapas. Analiza y determina la etapa correcta del cliente.

ETAPAS: ${stagesDescription}

ACTUAL: ${currentStageName}

CONVERSACIÓN:
${recentConversation}

REGLAS:
- Etapas avanzan 1→2→3
- Solo cambiar con evidencia clara
- Retroceder si cancela/cambia opinión

JSON (sin markdown): {"should_change":true/false,"new_stage_name":"etapa"|null,"reason":"motivo"}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.3
    });

    const responseText = response.choices[0]?.message?.content?.trim() || '';
    
    let decision;
    try {
      const cleanJson = responseText.replace(/```json\n?|\n?```/g, '').trim();
      decision = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error(`[FunnelEvaluator] Failed to parse LLM response: ${responseText}`);
      return;
    }

    console.log(`[FunnelEvaluator] LLM decision:`, decision);

    if (decision.should_change && decision.new_stage_name) {
      const targetStageName = decision.new_stage_name.toLowerCase().trim();
      let targetStage = stages.find(s => s.name.toLowerCase() === targetStageName);
      
      if (!targetStage) {
        targetStage = stages.find(s => s.name.toLowerCase().includes(targetStageName) || 
                                        targetStageName.includes(s.name.toLowerCase()));
      }
      
      if (!targetStage) {
        const stageNumber = parseInt(targetStageName.match(/\d+/)?.[0] || '0');
        if (stageNumber > 0 && stageNumber <= stages.length) {
          targetStage = stages[stageNumber - 1];
        }
      }

      if (targetStage && targetStage.id !== currentStatus.currentStage?.id) {
        await setContactStage(businessId, normalizedPhone, targetStage.id, instanceId || undefined);
        console.log(`[FunnelEvaluator] ✅ Stage updated: ${currentStageName} → ${targetStage.name} (${decision.reason})`);
      } else if (!targetStage) {
        console.log(`[FunnelEvaluator] ⚠️ Target stage "${decision.new_stage_name}" not found in: ${stages.map(s => s.name).join(', ')}`);
      } else {
        console.log(`[FunnelEvaluator] ℹ️ Already at target stage: ${currentStageName}`);
      }
    } else {
      console.log(`[FunnelEvaluator] ℹ️ No stage change needed: ${decision.reason || 'no reason provided'}`);
    }

    const tokensUsed = response.usage?.total_tokens || 0;
    console.log(`[FunnelEvaluator] Completed, tokens used: ${tokensUsed}`);

  } catch (error: any) {
    console.error(`[FunnelEvaluator] Error evaluating stage:`, error.message);
  } finally {
    await releaseLock(lockKey);
  }
}

export function triggerFunnelEvaluation(input: EvaluatorInput): void {
  evaluateFunnelStageAsync(input).catch(err => {
    console.error(`[FunnelEvaluator] Async evaluation failed:`, err.message);
  });
}

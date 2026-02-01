import prisma from '../prisma.js';
import { GeminiService } from '../gemini.js';
import { getContactStageStatus, setContactStage } from '../funnelStageService.js';
import { getRedisConnection, isRedisAvailable } from '../redis.js';
import { logTokenUsage, estimateGeminiTokens } from '../tokenLogger.js';

const gemini = new GeminiService();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const EVALUATION_COOLDOWN_MS = 30000;
const LOCK_TTL_SECONDS = 60;
const MAX_CONVERSATION_MESSAGES = 30;

interface EvaluatorInput {
  businessId: string;
  instanceId: string | null;
  contactPhone: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
}

function formatCleanConversation(messages: Array<{ role: 'user' | 'assistant'; content: string }>): string {
  const recent = messages.slice(-MAX_CONVERSATION_MESSAGES);
  return recent.map(m => {
    const speaker = m.role === 'user' ? 'CLIENTE' : 'ASESOR';
    const content = m.content.replace(/\s+/g, ' ').trim();
    return `${speaker}: ${content}`;
  }).join('\n');
}

function buildDynamicPrompt(
  stages: Array<{
    name: string;
    order: number;
    description: string | null;
    requiredFieldKeys: string[];
    blockedTopics: string[];
  }>,
  currentStageName: string,
  currentStageOrder: number,
  conversation: string
): string {
  const stagesDescription = stages.map((s, i) => {
    let desc = `${i + 1}. "${s.name}"`;
    if (s.description) desc += ` - ${s.description}`;
    if (s.requiredFieldKeys.length > 0) {
      desc += ` [Datos requeridos: ${s.requiredFieldKeys.join(', ')}]`;
    }
    if (s.blockedTopics.length > 0) {
      desc += ` [Temas bloqueados: ${s.blockedTopics.join(', ')}]`;
    }
    return desc;
  }).join('\n');

  const stageNames = stages.map(s => `"${s.name}"`).join(', ');

  return `Eres un evaluador de etapas de venta. Tu trabajo es analizar la conversación y determinar si el cliente debe cambiar de etapa.

## ETAPAS DEL FUNNEL (en orden)
${stagesDescription}

## ETAPA ACTUAL DEL CLIENTE
"${currentStageName}" (orden: ${currentStageOrder})

## CONVERSACIÓN RECIENTE
${conversation}

## REGLAS DE EVALUACIÓN
1. Las etapas avanzan en orden: 1 → 2 → 3, etc.
2. Solo cambiar si hay EVIDENCIA CLARA en la conversación
3. Solo puedes avanzar UNA etapa a la vez (de orden ${currentStageOrder} a orden ${currentStageOrder + 1})
4. Se puede retroceder si el cliente cancela o cambia de opinión
5. Si no hay suficiente evidencia, mantener la etapa actual

## INSTRUCCIONES
Analiza la conversación y responde SOLO con JSON (sin markdown):
{"should_change": true/false, "new_stage_name": "nombre exacto" | null, "reason": "explicación breve"}

IMPORTANTE: new_stage_name DEBE ser exactamente uno de: ${stageNames}`;
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

function validateStageTransition(
  currentOrder: number,
  targetOrder: number,
  totalStages: number
): boolean {
  if (targetOrder < 1 || targetOrder > totalStages) return false;
  if (targetOrder === currentOrder) return false;
  if (targetOrder > currentOrder + 1) return false;
  return true;
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
    console.log(`[FunnelEvaluator] Starting Gemini Flash evaluation for ${normalizedPhone}`);
    
    if (!gemini.isConfigured()) {
      console.log(`[FunnelEvaluator] Gemini not configured, skipping`);
      return;
    }

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
    const currentStageOrder = currentStageInList?.order || stages[0].order;

    const cleanConversation = formatCleanConversation(conversationHistory);
    
    const prompt = buildDynamicPrompt(
      stages.map(s => ({
        name: s.name,
        order: s.order,
        description: s.description,
        requiredFieldKeys: s.requiredFieldKeys,
        blockedTopics: s.blockedTopics
      })),
      currentStageName,
      currentStageOrder,
      cleanConversation
    );

    const startTime = Date.now();
    const response = await gemini.generateText(prompt, {
      temperature: 0.2,
      maxTokens: 300
    });

    if (!response.success) {
      console.error(`[FunnelEvaluator] Gemini error: ${response.error}`);
      return;
    }

    const responseText = response.text.trim();
    const duration = Date.now() - startTime;
    
    let decision;
    try {
      const cleanJson = responseText.replace(/```json\n?|\n?```/g, '').trim();
      decision = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error(`[FunnelEvaluator] Failed to parse Gemini response: ${responseText}`);
      return;
    }

    const promptTokens = estimateGeminiTokens(prompt);
    const completionTokens = estimateGeminiTokens(responseText);
    
    await logTokenUsage({
      businessId,
      feature: 'funnel_stage_evaluation',
      provider: 'gemini',
      model: GEMINI_MODEL,
      promptTokens,
      completionTokens
    });

    console.log(`[FunnelEvaluator] Gemini decision (${duration}ms):`, decision);

    if (decision.should_change && decision.new_stage_name) {
      const targetStageName = decision.new_stage_name.toLowerCase().trim();
      let targetStage = stages.find(s => s.name.toLowerCase() === targetStageName);
      
      if (!targetStage) {
        targetStage = stages.find(s => 
          s.name.toLowerCase().includes(targetStageName) || 
          targetStageName.includes(s.name.toLowerCase())
        );
      }
      
      if (!targetStage) {
        const stageNumber = parseInt(targetStageName.match(/\d+/)?.[0] || '0');
        if (stageNumber > 0 && stageNumber <= stages.length) {
          targetStage = stages[stageNumber - 1];
        }
      }

      if (targetStage && targetStage.id !== currentStatus.currentStage?.id) {
        if (!validateStageTransition(currentStageOrder, targetStage.order, stages.length)) {
          console.log(`[FunnelEvaluator] ⚠️ Invalid transition: ${currentStageName} (${currentStageOrder}) → ${targetStage.name} (${targetStage.order}) - skipping multi-stage jump`);
          return;
        }

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

    console.log(`[FunnelEvaluator] Completed with Gemini Flash, ~${promptTokens + completionTokens} tokens`);

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

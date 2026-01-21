import prisma from './prisma.js';
import { getExtractedDataForContact } from './dataExtractionService.js';
import { tryAutoCreateOrderOnStageAdvance } from './orderAutoCreator.js';

interface StageStatus {
  currentStage: {
    id: string;
    name: string;
    order: number;
    description: string | null;
    promptContext: string | null;
    blockedTopics: string[];
    requiredFieldKeys: string[];
  } | null;
  missingFields: string[];
  collectedFields: Record<string, string>;
  canAdvance: boolean;
  nextStage: { id: string; name: string } | null;
  allStages: Array<{ id: string; name: string; order: number; isComplete: boolean }>;
}

export async function getContactStageStatus(
  businessId: string,
  contactPhone: string
): Promise<StageStatus> {
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  const stages = await prisma.funnelStage.findMany({
    where: { businessId, isActive: true },
    orderBy: { order: 'asc' }
  });

  if (stages.length === 0) {
    return {
      currentStage: null,
      missingFields: [],
      collectedFields: {},
      canAdvance: false,
      nextStage: null,
      allStages: []
    };
  }

  let currentState = await prisma.contactFunnelState.findUnique({
    where: {
      businessId_contactPhone: {
        businessId,
        contactPhone: normalizedPhone
      }
    },
    include: { stage: true }
  });

  if (!currentState) {
    const firstStage = stages[0];
    currentState = await prisma.contactFunnelState.create({
      data: {
        businessId,
        contactPhone: normalizedPhone,
        stageId: firstStage.id
      },
      include: { stage: true }
    });
  }

  const extractedData = await getExtractedDataForContact(businessId, normalizedPhone);
  const currentStage = currentState.stage;

  const missingFields: string[] = [];
  const collectedFields: Record<string, string> = {};

  if (currentStage.requiredFieldKeys.length > 0) {
    const fields = await prisma.extractionField.findMany({
      where: { businessId, fieldKey: { in: currentStage.requiredFieldKeys } }
    });

    for (const fieldKey of currentStage.requiredFieldKeys) {
      const value = extractedData[fieldKey];
      if (value) {
        collectedFields[fieldKey] = value;
      } else {
        const field = fields.find(f => f.fieldKey === fieldKey);
        missingFields.push(field?.fieldLabel || fieldKey);
      }
    }
  }

  const canAdvance = missingFields.length === 0;
  const currentIndex = stages.findIndex(s => s.id === currentStage.id);
  const nextStage = currentIndex < stages.length - 1 ? stages[currentIndex + 1] : null;

  const allStages = stages.map((stage, index) => ({
    id: stage.id,
    name: stage.name,
    order: stage.order,
    isComplete: index < currentIndex || (index === currentIndex && canAdvance)
  }));

  return {
    currentStage: {
      id: currentStage.id,
      name: currentStage.name,
      order: currentStage.order,
      description: currentStage.description,
      promptContext: currentStage.promptContext,
      blockedTopics: currentStage.blockedTopics,
      requiredFieldKeys: currentStage.requiredFieldKeys
    },
    missingFields,
    collectedFields,
    canAdvance,
    nextStage: nextStage ? { id: nextStage.id, name: nextStage.name } : null,
    allStages
  };
}

export async function advanceContactStage(
  businessId: string,
  contactPhone: string,
  instanceId?: string
): Promise<{ success: boolean; newStage?: string; error?: string }> {
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  const status = await getContactStageStatus(businessId, normalizedPhone);
  
  if (!status.currentStage) {
    return { success: false, error: 'No funnel stages configured' };
  }

  if (!status.canAdvance) {
    return { success: false, error: `Missing required fields: ${status.missingFields.join(', ')}` };
  }

  if (!status.nextStage) {
    // Already at final stage - try to create order with current stage
    tryAutoCreateOrderOnStageAdvance(businessId, normalizedPhone, status.currentStage.name, instanceId)
      .then(result => {
        if (result.created) {
          console.log(`[FunnelStage] Auto-order created at final stage: ${result.orderId}`);
        }
      })
      .catch(err => console.error('[FunnelStage] Auto-order error at final stage:', err.message));
    
    return { success: true, newStage: status.currentStage.name };
  }

  await prisma.contactFunnelState.update({
    where: {
      businessId_contactPhone: {
        businessId,
        contactPhone: normalizedPhone
      }
    },
    data: {
      stageId: status.nextStage.id,
      enteredAt: new Date()
    }
  });

  console.log(`[FunnelStage] Contact ${normalizedPhone} advanced to stage: ${status.nextStage.name}`);
  
  tryAutoCreateOrderOnStageAdvance(businessId, normalizedPhone, status.nextStage.name, instanceId)
    .then(result => {
      if (result.created) {
        console.log(`[FunnelStage] Auto-order created on stage advance: ${result.orderId}`);
      }
    })
    .catch(err => console.error('[FunnelStage] Auto-order error:', err.message));
  
  return { success: true, newStage: status.nextStage.name };
}

export async function setContactStage(
  businessId: string,
  contactPhone: string,
  stageId: string,
  instanceId?: string
): Promise<{ success: boolean; stageName?: string; error?: string }> {
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  const stage = await prisma.funnelStage.findFirst({
    where: { id: stageId, businessId, isActive: true }
  });
  
  if (!stage) {
    return { success: false, error: 'Stage not found or inactive' };
  }
  
  await prisma.contactFunnelState.upsert({
    where: {
      businessId_contactPhone: {
        businessId,
        contactPhone: normalizedPhone
      }
    },
    create: {
      businessId,
      contactPhone: normalizedPhone,
      stageId: stage.id,
      enteredAt: new Date()
    },
    update: {
      stageId: stage.id,
      enteredAt: new Date()
    }
  });
  
  console.log(`[FunnelStage] Contact ${normalizedPhone} manually set to stage: ${stage.name}`);
  
  tryAutoCreateOrderOnStageAdvance(businessId, normalizedPhone, stage.name, instanceId)
    .then(result => {
      if (result.created) {
        console.log(`[FunnelStage] Auto-order created on manual stage set: ${result.orderId}`);
      }
    })
    .catch(err => console.error('[FunnelStage] Auto-order error on manual set:', err.message));
  
  return { success: true, stageName: stage.name };
}

export async function checkAndAdvanceStage(
  businessId: string,
  contactPhone: string,
  instanceId?: string
): Promise<void> {
  try {
    const status = await getContactStageStatus(businessId, contactPhone);
    
    if (status.canAdvance && status.nextStage) {
      await advanceContactStage(businessId, contactPhone, instanceId);
    }
  } catch (err: any) {
    console.error('[FunnelStage] Error checking stage advancement:', err.message);
  }
}

export function buildStageContextForPrompt(status: StageStatus): string {
  if (!status.currentStage) {
    return '';
  }

  let context = `\n\n## ETAPA ACTUAL DEL CLIENTE: ${status.currentStage.name}`;
  
  if (status.currentStage.description) {
    context += `\n${status.currentStage.description}`;
  }

  if (status.currentStage.promptContext) {
    context += `\n\n### Instrucciones para esta etapa:\n${status.currentStage.promptContext}`;
  }

  if (status.missingFields.length > 0) {
    context += `\n\n### DATOS PENDIENTES (debes obtener estos datos antes de avanzar):`;
    status.missingFields.forEach(field => {
      context += `\n- ❌ ${field}`;
    });
  }

  if (Object.keys(status.collectedFields).length > 0) {
    context += `\n\n### Datos ya recolectados:`;
    for (const [key, value] of Object.entries(status.collectedFields)) {
      context += `\n- ✅ ${key}: ${value}`;
    }
  }

  if (status.currentStage.blockedTopics.length > 0) {
    context += `\n\n### ⛔ TEMAS BLOQUEADOS (NO mencionar hasta completar los datos pendientes):`;
    status.currentStage.blockedTopics.forEach(topic => {
      context += `\n- ${topic}`;
    });
    context += `\n\nSi el cliente pregunta por estos temas, valida su interés y redirige para obtener los datos faltantes primero.`;
  }

  return context;
}

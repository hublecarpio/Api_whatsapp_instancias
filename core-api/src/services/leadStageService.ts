import prisma from './prisma.js';
import { geminiService } from './gemini.js';
import { dispatchStageChange } from './webhookService.js';
import { getRedisConnection, isRedisAvailable } from './redis.js';

const LEAD_STAGE_COOLDOWN_MS = 30000;
const MAX_MESSAGES = 50;
const MAX_CONTENT_LENGTH = 200;

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

function compactMessages(messages: Array<{ direction: string; message: string | null }>): ConversationMessage[] {
  return messages.map(msg => ({
    role: msg.direction === 'incoming' ? 'user' as const : 'assistant' as const,
    content: (msg.message || '[Media]').replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_LENGTH)
  }));
}

async function checkLeadStageCooldown(businessId: string, contactPhone: string): Promise<boolean> {
  if (!isRedisAvailable()) return true;
  try {
    const redis = getRedisConnection();
    const key = `lead_stage_cooldown:${businessId}:${contactPhone}`;
    const lastRun = await redis.get(key);
    if (lastRun && Date.now() - parseInt(lastRun) < LEAD_STAGE_COOLDOWN_MS) {
      return false;
    }
    await redis.set(key, Date.now().toString(), 'EX', Math.ceil(LEAD_STAGE_COOLDOWN_MS / 1000));
    return true;
  } catch {
    return true;
  }
}

export async function analyzeAndUpdateLeadStage(
  businessId: string,
  contactPhone: string
): Promise<{ success: boolean; newStage?: string; confidence?: number; reasoning?: string; error?: string }> {
  try {
    const normalizedPhone = contactPhone.replace(/\D/g, '');
    
    const canProceed = await checkLeadStageCooldown(businessId, normalizedPhone);
    if (!canProceed) {
      return { success: false, error: 'Cooldown active' };
    }
    
    if (!geminiService.isConfigured()) {
      return { success: false, error: 'Gemini API not configured' };
    }

    const tags = await prisma.tag.findMany({
      where: { businessId, type: 'SYSTEM' },
      orderBy: { order: 'asc' }
    });

    if (tags.length === 0) {
      return { success: false, error: 'No SYSTEM tags configured for this business' };
    }

    const messages = await prisma.messageLog.findMany({
      where: {
        businessId,
        OR: [
          { sender: normalizedPhone },
          { recipient: normalizedPhone },
          { sender: { contains: normalizedPhone } },
          { recipient: { contains: normalizedPhone } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_MESSAGES
    });

    if (messages.length === 0) {
      return { success: false, error: 'No messages found for this contact' };
    }

    const conversationHistory = compactMessages(messages.reverse());

    const availableStages = tags.map(tag => ({
      name: tag.name,
      description: tag.description || tag.name
    }));

    // Get only SYSTEM tag assignments for AI stage analysis (preserves MANUAL tags)
    const currentAssignments = await prisma.tagAssignment.findMany({
      where: {
        businessId,
        contactPhone,
        tag: { type: 'SYSTEM' }
      },
      include: { tag: true }
    });

    // Use first SYSTEM tag for stage analysis
    const currentStageName = currentAssignments.length > 0 ? currentAssignments[0].tag?.name : undefined;

    const analysis = await geminiService.analyzeLeadStage(
      conversationHistory, 
      availableStages,
      currentStageName
    );

    if (!analysis.success || !analysis.stageName) {
      return { success: false, error: analysis.error || 'Could not determine stage' };
    }

    const targetTag = tags.find(
      t => t.name.toLowerCase() === analysis.stageName.toLowerCase()
    );

    if (!targetTag) {
      return { success: false, error: `Stage "${analysis.stageName}" not found in available tags` };
    }

    const currentAssignment = currentAssignments.length > 0 ? currentAssignments[0] : null;
    
    if (!analysis.shouldChange || currentAssignment?.tagId === targetTag.id) {
      return {
        success: true,
        newStage: currentStageName || analysis.stageName,
        confidence: analysis.confidence,
        reasoning: analysis.shouldChange === false 
          ? `Mantiene etapa actual: ${analysis.reasoning}`
          : 'Stage unchanged - already at this stage'
      };
    }

    // Remove only SYSTEM tag assignments for this contact (preserves MANUAL tags)
    const systemTagIds = tags.map(t => t.id);
    
    if (currentAssignments.length > 0) {
      await prisma.tagAssignment.deleteMany({
        where: {
          businessId,
          contactPhone,
          tagId: { in: systemTagIds }
        }
      });
      
      await prisma.tagHistory.updateMany({
        where: {
          businessId,
          contactPhone,
          tagId: { in: systemTagIds },
          removedAt: null
        },
        data: { removedAt: new Date() }
      });
    }

    // Create new SYSTEM tag assignment
    await prisma.tagAssignment.create({
      data: {
        tagId: targetTag.id,
        businessId,
        contactPhone,
        source: 'ai_auto'
      }
    });

    await prisma.tagHistory.create({
      data: {
        tagId: targetTag.id,
        businessId,
        contactPhone,
        source: 'ai_auto',
        notes: `AI confidence: ${(analysis.confidence * 100).toFixed(0)}% - ${analysis.reasoning}`
      }
    });

    console.log(`[LEAD STAGE] Updated ${contactPhone} to "${analysis.stageName}" (confidence: ${analysis.confidence})`);
    
    // Dispatch stage_change webhook
    dispatchStageChange(
      businessId,
      contactPhone,
      currentStageName || null,
      analysis.stageName
    ).catch(err => console.error('[LEAD STAGE] Failed to dispatch stage_change webhook:', err.message));

    return {
      success: true,
      newStage: analysis.stageName,
      confidence: analysis.confidence,
      reasoning: analysis.reasoning
    };
  } catch (error: any) {
    console.error('[LEAD STAGE] Error analyzing lead stage:', error);
    return { success: false, error: error.message };
  }
}

export async function extractAndSaveContactData(
  businessId: string,
  contactPhone: string,
  requiredFields?: string[]
): Promise<{ success: boolean; data?: Record<string, string>; error?: string }> {
  try {
    if (!geminiService.isConfigured()) {
      return { success: false, error: 'Gemini API not configured' };
    }

    const defaultFields = ['nombre', 'email', 'direccion', 'ciudad', 'telefono_alternativo'];
    const fields = requiredFields && requiredFields.length > 0 ? requiredFields : defaultFields;

    const messages = await prisma.messageLog.findMany({
      where: {
        businessId,
        OR: [
          { sender: contactPhone },
          { recipient: contactPhone }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 40
    });

    if (messages.length === 0) {
      return { success: false, error: 'No messages found for this contact' };
    }

    const conversationHistory = messages
      .reverse()
      .map(msg => ({
        role: msg.direction === 'incoming' ? 'user' as const : 'assistant' as const,
        content: msg.message || ''
      }))
      .filter(msg => msg.content);

    const result = await geminiService.extractContactData(conversationHistory, fields);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    const cleanData: Record<string, string> = {};
    for (const [key, value] of Object.entries(result.data)) {
      if (value && value !== 'null' && value !== null) {
        cleanData[key] = String(value);
      }
    }

    if (Object.keys(cleanData).length > 0) {
      const existingSettings = await prisma.contactSettings.findFirst({
        where: {
          businessId,
          contactPhone
        }
      });

      const existingNotes = existingSettings?.notes || '{}';
      let parsedNotes: Record<string, any> = {};
      try {
        parsedNotes = JSON.parse(existingNotes);
      } catch {}

      const mergedData = { ...parsedNotes, extractedData: cleanData, lastExtracted: new Date().toISOString() };

      if (existingSettings) {
        await prisma.contactSettings.update({
          where: { id: existingSettings.id },
          data: { notes: JSON.stringify(mergedData) }
        });
      } else {
        await prisma.contactSettings.create({
          data: {
            businessId,
            contactPhone,
            notes: JSON.stringify(mergedData)
          }
        });
      }

      console.log(`[LEAD DATA] Extracted data for ${contactPhone}:`, cleanData);
    }

    return { success: true, data: cleanData };
  } catch (error: any) {
    console.error('[LEAD DATA] Error extracting contact data:', error);
    return { success: false, error: error.message };
  }
}

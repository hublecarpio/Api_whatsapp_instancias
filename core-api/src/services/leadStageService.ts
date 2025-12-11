import prisma from './prisma.js';
import { geminiService } from './gemini.js';

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function analyzeAndUpdateLeadStage(
  businessId: string,
  contactPhone: string
): Promise<{ success: boolean; newStage?: string; confidence?: number; reasoning?: string; error?: string }> {
  try {
    if (!geminiService.isConfigured()) {
      return { success: false, error: 'Gemini API not configured' };
    }

    const tags = await prisma.tag.findMany({
      where: { businessId },
      orderBy: { order: 'asc' }
    });

    if (tags.length === 0) {
      return { success: false, error: 'No tags configured for this business' };
    }

    const messages = await prisma.messageLog.findMany({
      where: {
        businessId,
        OR: [
          { sender: contactPhone },
          { recipient: contactPhone }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 30
    });

    if (messages.length === 0) {
      return { success: false, error: 'No messages found for this contact' };
    }

    const conversationHistory: ConversationMessage[] = messages
      .reverse()
      .map(msg => ({
        role: msg.direction === 'incoming' ? 'user' as const : 'assistant' as const,
        content: msg.message || '[Media]'
      }));

    const availableStages = tags.map(tag => ({
      name: tag.name,
      description: tag.description || tag.name
    }));

    const analysis = await geminiService.analyzeLeadStage(conversationHistory, availableStages);

    if (!analysis.success || !analysis.stageName) {
      return { success: false, error: analysis.error || 'Could not determine stage' };
    }

    const targetTag = tags.find(
      t => t.name.toLowerCase() === analysis.stageName.toLowerCase()
    );

    if (!targetTag) {
      return { success: false, error: `Stage "${analysis.stageName}" not found in available tags` };
    }

    const currentAssignment = await prisma.tagAssignment.findUnique({
      where: {
        businessId_contactPhone: {
          businessId,
          contactPhone
        }
      },
      include: { tag: true }
    });

    if (currentAssignment?.tagId === targetTag.id) {
      return {
        success: true,
        newStage: analysis.stageName,
        confidence: analysis.confidence,
        reasoning: 'Stage unchanged - already at this stage'
      };
    }

    if (currentAssignment) {
      await prisma.tagHistory.updateMany({
        where: {
          businessId,
          contactPhone,
          removedAt: null
        },
        data: { removedAt: new Date() }
      });
    }

    await prisma.tagAssignment.upsert({
      where: {
        businessId_contactPhone: {
          businessId,
          contactPhone
        }
      },
      update: {
        tagId: targetTag.id,
        assignedAt: new Date(),
        source: 'ai_auto'
      },
      create: {
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

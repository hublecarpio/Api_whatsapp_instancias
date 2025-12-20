import prisma from './prisma.js';
import { callOpenAI, ChatMessage, isOpenAIConfigured, logTokenUsage } from './openaiService.js';
import { dispatchStateChange } from './webhookService.js';

interface ExtractionResult {
  fieldKey: string;
  value: string | null;
  confidence: number;
}

export async function extractDataFromConversation(
  businessId: string,
  contactPhone: string,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<ExtractionResult[]> {
  try {
    if (!isOpenAIConfigured()) {
      console.log('[DataExtraction] OpenAI not configured, skipping extraction');
      return [];
    }

    const fields = await prisma.extractionField.findMany({
      where: { businessId, enabled: true },
      orderBy: { order: 'asc' }
    });

    if (fields.length === 0) {
      return [];
    }

    const existingData = await prisma.contactExtractedData.findMany({
      where: { businessId, contactPhone }
    });

    const existingMap: Record<string, { value: string | null; source: string }> = {};
    existingData.forEach(d => {
      existingMap[d.fieldKey] = { value: d.fieldValue, source: (d as any).source || 'unknown' };
    });

    const fieldsToExtract = (fields as any[]).filter(f => {
      const existing = existingMap[f.fieldKey];
      if (!existing || !existing.value) return true;
      if (existing.source === 'manual') return false;
      return true;
    });

    if (fieldsToExtract.length === 0) {
      console.log('[DataExtraction] All fields already extracted with manual values');
      return [];
    }

    const conversationText = conversationHistory
      .slice(-6)
      .map(m => `${m.role === 'user' ? 'Cliente' : 'Agente'}: ${m.content}`)
      .join('\n');

    const fieldDescriptions = fieldsToExtract.map((f: any) => 
      `- ${f.fieldKey} (${f.fieldLabel}): ${f.description || f.fieldLabel}`
    ).join('\n');

    const systemPrompt = `Eres un asistente de extracción de datos. Tu tarea es identificar información específica de una conversación y extraerla.

Analiza la conversación y extrae los siguientes campos si están presentes:
${fieldDescriptions}

REGLAS:
1. Solo extrae información que el CLIENTE haya proporcionado explícitamente
2. No inventes datos ni hagas suposiciones
3. Si un dato no está presente, devuelve null
4. Para emails, valida que tenga formato correcto
5. Para teléfonos, extrae solo los dígitos
6. Devuelve un JSON con el formato: {"fieldKey": "valor o null", ...}

Responde SOLO con el JSON, sin explicaciones.`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Conversación:\n${conversationText}\n\nExtrae los datos solicitados.` }
    ];

    const result = await callOpenAI({
      model: 'gpt-4.1-nano',
      messages,
      maxTokens: 500,
      temperature: 0.1,
      maxHistoryTokens: 1000,
      context: {
        businessId,
        feature: 'data_extraction'
      }
    });

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { userId: true }
    });

    if (business && result.usage) {
      logTokenUsage({
        businessId,
        userId: business.userId,
        feature: 'data_extraction',
        model: 'gpt-4.1-nano',
        promptTokens: result.usage.promptTokens || 0,
        completionTokens: result.usage.completionTokens || 0,
        totalTokens: result.usage.totalTokens || 0
      }).catch(err => console.error('[DataExtraction] Token logging failed:', err.message));
    }

    let extractedJson: Record<string, string | null>;
    try {
      const cleanedContent = result.content.replace(/```json\n?|\n?```/g, '').trim();
      extractedJson = JSON.parse(cleanedContent);
    } catch (parseErr) {
      console.error('[DataExtraction] Failed to parse extraction result:', result.content);
      return [];
    }

    const results: ExtractionResult[] = [];
    for (const field of fieldsToExtract as any[]) {
      const value = extractedJson[field.fieldKey];
      if (value !== undefined && value !== null && value !== '') {
        results.push({
          fieldKey: field.fieldKey,
          value: String(value),
          confidence: 0.85
        });
      }
    }

    return results;
  } catch (error: any) {
    console.error('[DataExtraction] Error extracting data:', error.message);
    return [];
  }
}

export async function saveExtractedData(
  businessId: string,
  contactPhone: string,
  extractedData: ExtractionResult[]
): Promise<void> {
  try {
    for (const data of extractedData) {
      const existing = await prisma.contactExtractedData.findUnique({
        where: {
          businessId_contactPhone_fieldKey: {
            businessId,
            contactPhone,
            fieldKey: data.fieldKey
          }
        }
      });

      if (existing) {
        const existingSource = (existing as any).source || 'unknown';
        
        // Priority: manual (highest) > tool > ai (lowest)
        // Never overwrite manual values
        if (existingSource === 'manual') {
          console.log(`[DataExtraction] Skipping ${data.fieldKey} - has manual value`);
          continue;
        }
        
        // Don't overwrite tool values with AI values
        if (existingSource === 'tool' && data.confidence < 1.0) {
          console.log(`[DataExtraction] Skipping ${data.fieldKey} - tool value has higher priority`);
          continue;
        }
        
        // Skip if value is the same (no need to update)
        if (existing.fieldValue === data.value) {
          console.log(`[DataExtraction] Skipping ${data.fieldKey} - value unchanged`);
          continue;
        }
      }

      const oldValue = existing?.fieldValue || null;
      
      await (prisma.contactExtractedData as any).upsert({
        where: {
          businessId_contactPhone_fieldKey: {
            businessId,
            contactPhone,
            fieldKey: data.fieldKey
          }
        },
        create: {
          businessId,
          contactPhone,
          fieldKey: data.fieldKey,
          fieldValue: data.value,
          confidence: data.confidence,
          source: 'ai'
        },
        update: {
          fieldValue: data.value,
          confidence: data.confidence,
          source: 'ai'
        }
      });

      console.log(`[DataExtraction] Saved ${data.fieldKey}=${data.value} for ${contactPhone}`);
      
      // Dispatch state_change webhook for extracted data
      dispatchStateChange(businessId, contactPhone, 'data', 
        { [data.fieldKey]: oldValue }, 
        { [data.fieldKey]: data.value }
      ).catch(err => console.error('[DataExtraction] Failed to dispatch state_change webhook:', err.message));
    }
  } catch (error: any) {
    console.error('[DataExtraction] Error saving extracted data:', error.message);
  }
}

export async function getExtractedDataForContact(
  businessId: string,
  contactPhone: string
): Promise<Record<string, string>> {
  try {
    const data = await prisma.contactExtractedData.findMany({
      where: { businessId, contactPhone }
    });

    const result: Record<string, string> = {};
    data.forEach(d => {
      if (d.fieldValue) {
        result[d.fieldKey] = d.fieldValue;
      }
    });

    return result;
  } catch (error: any) {
    console.error('[DataExtraction] Error getting extracted data:', error.message);
    return {};
  }
}

export async function getAppointmentFieldsData(
  businessId: string,
  contactPhone: string
): Promise<Record<string, string>> {
  try {
    const fields = await (prisma.extractionField as any).findMany({
      where: { businessId, enabled: true, useForAppointment: true },
      orderBy: { order: 'asc' }
    });

    if (fields.length === 0) {
      return {};
    }

    const fieldKeys = fields.map((f: any) => f.fieldKey);

    const data = await prisma.contactExtractedData.findMany({
      where: { 
        businessId, 
        contactPhone,
        fieldKey: { in: fieldKeys }
      }
    });

    const result: Record<string, string> = {};
    data.forEach(d => {
      if (d.fieldValue) {
        result[d.fieldKey] = d.fieldValue;
      }
    });

    return result;
  } catch (error: any) {
    console.error('[DataExtraction] Error getting appointment fields:', error.message);
    return {};
  }
}

export async function processDataExtraction(
  businessId: string,
  contactPhone: string
): Promise<void> {
  try {
    const normalizedPhone = contactPhone.replace(/\D/g, '').replace(/:.*$/, '');

    const recentMessages = await prisma.messageLog.findMany({
      where: { 
        businessId,
        OR: [
          { sender: normalizedPhone },
          { recipient: normalizedPhone }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 6
    });

    if (recentMessages.length === 0) {
      return;
    }

    const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = recentMessages.reverse().map(msg => ({
      role: (msg.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: msg.message || ''
    }));

    const extractedData = await extractDataFromConversation(
      businessId,
      normalizedPhone,
      conversationHistory
    );

    if (extractedData.length > 0) {
      await saveExtractedData(businessId, normalizedPhone, extractedData);
      console.log(`[DataExtraction] Extracted ${extractedData.length} fields for ${normalizedPhone}`);
    }
  } catch (error: any) {
    console.error('[DataExtraction] Error in processDataExtraction:', error.message);
  }
}

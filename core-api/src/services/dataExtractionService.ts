import prisma from './prisma.js';
import { callOpenAI, ChatMessage, isOpenAIConfigured, logTokenUsage } from './openaiService.js';
import { dispatchStateChange } from './webhookService.js';
import { tryAutoCreateOrderOnDataUpdate } from './orderAutoCreator.js';
import { checkAndAdvanceStage } from './funnelStageService.js';

// List of profanity/insult patterns to filter out from extracted data
const PROFANITY_PATTERNS = [
  /conchatumadre/i, /conchatu/i, /reconchatu/i,
  /mierda/i, /puta/i, /carajo/i, /cojudo/i, /huevon/i, /webón/i,
  /imbecil/i, /estupido/i, /idiota/i, /pendejo/i, /cabron/i,
  /fuck/i, /shit/i, /bitch/i, /asshole/i, /bastard/i,
  /chucha/i, /ctm/i, /csm/i, /ptm/i, /hdp/i,
  /verga/i, /culiao/i, /maricon/i, /marica/i
];

function containsProfanity(value: string): boolean {
  if (!value || typeof value !== 'string') return false;
  const cleanValue = value.toLowerCase().replace(/\s+/g, '');
  return PROFANITY_PATTERNS.some(pattern => pattern.test(cleanValue));
}

function isValidExtractedValue(fieldKey: string, value: string): { valid: boolean; reason?: string } {
  if (!value || typeof value !== 'string') {
    return { valid: false, reason: 'empty value' };
  }
  
  // Check for profanity in name-related fields
  const nameFields = ['nombre', 'name', 'nombre_completo', 'nombreCompleto', 'cliente', 'nombres'];
  if (nameFields.some(f => fieldKey.toLowerCase().includes(f.toLowerCase()))) {
    if (containsProfanity(value)) {
      return { valid: false, reason: 'profanity detected in name field' };
    }
    // Names should be at least 2 characters and contain letters, spaces, hyphens, apostrophes
    if (value.length < 2 || !/^[a-záéíóúñüA-ZÁÉÍÓÚÑÜ\s\-']+$/.test(value)) {
      return { valid: false, reason: 'invalid name format' };
    }
  }
  
  // General profanity check for all fields
  if (containsProfanity(value)) {
    console.log(`[DataExtraction] ⚠️ Profanity filtered from ${fieldKey}: "${value}"`);
    return { valid: false, reason: 'profanity detected' };
  }
  
  return { valid: true };
}

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

    const clientMessagesOnly = conversationHistory
      .filter(m => m.role === 'user')
      .filter(m => {
        const content = m.content.toLowerCase();
        if (content.includes('[descripción de imagen]') || content.includes('[descripcion de imagen]')) {
          return false;
        }
        if (content.includes('[audio transcrito]') || content.includes('[video analizado]')) {
          return false;
        }
        return true;
      })
      .slice(-8);
    
    if (clientMessagesOnly.length === 0) {
      console.log('[DataExtraction] No client messages found for extraction');
      return [];
    }
    
    const conversationText = clientMessagesOnly
      .map(m => `Cliente: ${m.content}`)
      .join('\n');

    const fieldDescriptions = fieldsToExtract.map((f: any) => 
      `- ${f.fieldKey} (${f.fieldLabel}): ${f.description || f.fieldLabel}`
    ).join('\n');

    const systemPrompt = `Eres un asistente de extracción de datos. Tu tarea es identificar información específica de los mensajes ESCRITOS por el cliente y extraerla.

Analiza SOLO los mensajes del cliente y extrae los siguientes campos si están presentes:
${fieldDescriptions}

REGLAS CRÍTICAS:
1. Solo extrae información que el CLIENTE haya ESCRITO explícitamente en sus mensajes de texto
2. IGNORA COMPLETAMENTE cualquier información que provenga de:
   - Comprobantes de pago (Yape, Plin, transferencias bancarias)
   - Nombres de destinatarios o remitentes en vouchers
   - Descripciones de imágenes o capturas de pantalla
   - Metadatos de transacciones financieras
3. El NOMBRE del cliente es el que él/ella ESCRIBE en el chat, NO el nombre que aparece en un voucher de pago
4. No inventes datos ni hagas suposiciones
5. Si un dato no está presente en texto escrito por el cliente, devuelve null
6. Para emails, valida que tenga formato correcto
7. Para teléfonos, extrae solo los dígitos
8. Devuelve un JSON con el formato: {"fieldKey": "valor o null", ...}

EJEMPLO DE ERROR A EVITAR:
- Si el cliente escribe "Mi nombre es María García" y luego envía un voucher de Yape con el nombre "Juan Pérez", 
  el nombre correcto es "María García" (lo que escribió), NO "Juan Pérez" (del voucher).

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
  extractedData: ExtractionResult[],
  instanceId?: string
): Promise<void> {
  try {
    for (const data of extractedData) {
      // Validate extracted value before saving
      if (data.value) {
        const validation = isValidExtractedValue(data.fieldKey, data.value);
        if (!validation.valid) {
          console.log(`[DataExtraction] ❌ Rejected ${data.fieldKey}="${data.value}" - ${validation.reason}`);
          continue;
        }
      }
      
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
      
      // Try auto-create order when key fields are updated
      tryAutoCreateOrderOnDataUpdate(businessId, contactPhone, data.fieldKey, instanceId)
        .then(result => {
          if (result.created) {
            console.log(`[DataExtraction] Auto-order created on data update: ${result.orderId}`);
          }
        })
        .catch(err => console.error('[DataExtraction] Auto-order error:', err.message));
    }
    
    // After saving all data, check if contact can advance to next funnel stage
    if (extractedData.length > 0) {
      checkAndAdvanceStage(businessId, contactPhone, instanceId)
        .catch(err => console.error('[DataExtraction] Stage advance check error:', err.message));
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
  contactPhone: string,
  instanceId?: string
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
      await saveExtractedData(businessId, normalizedPhone, extractedData, instanceId);
      console.log(`[DataExtraction] Extracted ${extractedData.length} fields for ${normalizedPhone}`);
    }
  } catch (error: any) {
    console.error('[DataExtraction] Error in processDataExtraction:', error.message);
  }
}

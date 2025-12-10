import prisma from './prisma.js';
import { geminiService } from './gemini.js';

interface ExtractionResult {
  success: boolean;
  extractedData: Record<string, string | null>;
  fieldsExtracted: number;
  error?: string;
}

export async function getExtractionFieldsForBusiness(businessId: string) {
  let fields = await prisma.extractionField.findMany({
    where: { businessId, enabled: true },
    orderBy: { order: 'asc' }
  });

  if (fields.length === 0) {
    const defaultFields = [
      { fieldKey: 'nombre', fieldLabel: 'Nombre completo', required: true, order: 0 },
      { fieldKey: 'email', fieldLabel: 'Email', required: false, order: 1 },
      { fieldKey: 'direccion', fieldLabel: 'Dirección', required: false, order: 2 },
      { fieldKey: 'ciudad', fieldLabel: 'Ciudad', required: false, order: 3 },
      { fieldKey: 'telefono_alternativo', fieldLabel: 'Teléfono alternativo', required: false, order: 4 }
    ];

    await prisma.extractionField.createMany({
      data: defaultFields.map(f => ({
        businessId,
        fieldKey: f.fieldKey,
        fieldLabel: f.fieldLabel,
        fieldType: 'text',
        required: f.required,
        order: f.order,
        enabled: true
      }))
    });

    fields = await prisma.extractionField.findMany({
      where: { businessId, enabled: true },
      orderBy: { order: 'asc' }
    });
  }

  return fields;
}

export async function extractContactDataFromConversation(
  businessId: string,
  contactPhone: string,
  conversationHistory: { role: string; content: string }[]
): Promise<ExtractionResult> {
  try {
    const fields = await getExtractionFieldsForBusiness(businessId);
    
    if (fields.length === 0) {
      return { success: true, extractedData: {}, fieldsExtracted: 0 };
    }

    const fieldLabels = fields.map(f => f.fieldLabel);
    const fieldKeyMap: Record<string, string> = {};
    fields.forEach(f => {
      fieldKeyMap[f.fieldLabel.toLowerCase()] = f.fieldKey;
    });

    const result = await geminiService.extractContactData(conversationHistory, fieldLabels);
    
    if (!result.success) {
      return { success: false, extractedData: {}, fieldsExtracted: 0, error: result.error };
    }

    const normalizedData: Record<string, string | null> = {};
    let fieldsExtracted = 0;

    for (const [label, value] of Object.entries(result.data)) {
      const fieldKey = fieldKeyMap[label.toLowerCase()];
      if (fieldKey && value !== null && value !== undefined && value !== '') {
        normalizedData[fieldKey] = String(value);
        fieldsExtracted++;
      }
    }

    if (fieldsExtracted > 0) {
      const cleanPhone = contactPhone.replace(/\D/g, '');
      
      const updates = Object.entries(normalizedData).map(([fieldKey, fieldValue]) =>
        prisma.contactExtractedData.upsert({
          where: {
            businessId_contactPhone_fieldKey: {
              businessId,
              contactPhone: cleanPhone,
              fieldKey
            }
          },
          create: {
            businessId,
            contactPhone: cleanPhone,
            fieldKey,
            fieldValue
          },
          update: {
            fieldValue,
            updatedAt: new Date()
          }
        })
      );

      await Promise.all(updates);
      console.log(`[EXTRACTION] Saved ${fieldsExtracted} fields for contact ${cleanPhone}`);
    }

    return { success: true, extractedData: normalizedData, fieldsExtracted };
  } catch (error: any) {
    console.error('[EXTRACTION] Error:', error.message);
    return { success: false, extractedData: {}, fieldsExtracted: 0, error: error.message };
  }
}

export async function getContactExtractedData(businessId: string, contactPhone: string) {
  const cleanPhone = contactPhone.replace(/\D/g, '');
  
  const [extractedData, fields] = await Promise.all([
    prisma.contactExtractedData.findMany({
      where: { businessId, contactPhone: cleanPhone }
    }),
    prisma.extractionField.findMany({
      where: { businessId, enabled: true },
      orderBy: { order: 'asc' }
    })
  ]);

  const dataMap: Record<string, string | null> = {};
  extractedData.forEach(d => {
    dataMap[d.fieldKey] = d.fieldValue;
  });

  return fields.map(field => ({
    fieldKey: field.fieldKey,
    fieldLabel: field.fieldLabel,
    fieldType: field.fieldType,
    required: field.required,
    value: dataMap[field.fieldKey] || null
  }));
}

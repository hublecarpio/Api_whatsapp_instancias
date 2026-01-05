import prisma from './prisma.js';
import axios from 'axios';
import { MetaCloudService } from './metaCloud.js';
import { isOpenAIConfigured, callOpenAI, getModelForAgent, ChatMessage } from './openaiService.js';

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';

function cleanMarkdownForWhatsApp(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2');
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
  cleaned = cleaned.replace(/\*+/g, '');
  cleaned = cleaned.replace(/^#+\s*/gm, '');
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

async function getActiveInstance(businessId: string) {
  const connectedInstance = await prisma.whatsAppInstance.findFirst({
    where: { 
      businessId,
      isActive: true,
      status: 'connected'
    },
    include: { metaCredential: true, metaCoexistCredential: true },
    orderBy: { lastConnection: 'desc' }
  });
  
  if (connectedInstance) return connectedInstance;
  
  const activeInstance = await prisma.whatsAppInstance.findFirst({
    where: { 
      businessId,
      isActive: true
    },
    include: { metaCredential: true, metaCoexistCredential: true },
    orderBy: { lastConnection: 'desc' }
  });
  
  if (activeInstance) return activeInstance;
  
  const anyInstance = await prisma.whatsAppInstance.findFirst({
    where: { businessId },
    include: { metaCredential: true, metaCoexistCredential: true },
    orderBy: { lastConnection: 'desc' }
  });
  
  if (anyInstance) {
    console.log(`[REMINDER] Found instance ${anyInstance.id} for business ${businessId} (isActive=${anyInstance.isActive}, status=${anyInstance.status})`);
    return anyInstance;
  }
  
  try {
    const response = await axios.get(`${WA_API_URL}/instances`, { timeout: 5000 });
    const rawData = response.data?.instances || response.data;
    const instances = Array.isArray(rawData) ? rawData : [];
    
    const businessPrefix = `biz_${businessId.substring(0, 8)}`;
    const waInstance = instances.find((inst: any) => 
      inst.id?.startsWith(businessPrefix) || inst.businessId === businessId
    );
    
    if (waInstance && waInstance.status === 'connected') {
      console.log(`[REMINDER] Found Baileys instance from WA API: ${waInstance.id} for business ${businessId}`);
      return {
        id: waInstance.id,
        businessId,
        provider: 'BAILEYS' as const,
        instanceBackendId: waInstance.id,
        status: waInstance.status,
        isActive: true,
        metaCredential: null,
        metaCoexistCredential: null
      };
    }
  } catch (err: any) {
    console.log(`[REMINDER] Could not query WhatsApp API for instances: ${err.message}`);
  }
  
  return null;
}

async function checkWindowStatus(businessId: string, contactPhone: string): Promise<{
  requiresTemplate: boolean;
  provider: string | null;
  hoursSinceLastMessage: number | null;
}> {
  const instance = await getActiveInstance(businessId);
  
  if (!instance) {
    console.log(`[REMINDER] No active instance found for business ${businessId}`);
    return { requiresTemplate: false, provider: null, hoursSinceLastMessage: null };
  }
  
  if (instance.provider !== 'META_CLOUD' && instance.provider !== 'META_COEXIST') {
    return { requiresTemplate: false, provider: instance.provider, hoursSinceLastMessage: null };
  }
  
  const cleanPhone = contactPhone.replace(/\D/g, '');
  
  const lastInboundMessage = await prisma.messageLog.findFirst({
    where: {
      businessId,
      sender: cleanPhone,
      direction: 'inbound'
    },
    orderBy: { createdAt: 'desc' }
  });
  
  if (!lastInboundMessage) {
    console.log(`[REMINDER] No inbound message found for ${cleanPhone} - requiresTemplate=true`);
    return { requiresTemplate: true, provider: 'META_CLOUD', hoursSinceLastMessage: null };
  }
  
  const hoursSinceLastMessage = (Date.now() - lastInboundMessage.createdAt.getTime()) / (1000 * 60 * 60);
  const requiresTemplate = hoursSinceLastMessage >= 24;
  
  console.log(`[REMINDER] Window check for ${cleanPhone}: ${hoursSinceLastMessage.toFixed(2)}h since last inbound, requiresTemplate=${requiresTemplate}`);
  
  return { requiresTemplate, provider: 'META_CLOUD', hoursSinceLastMessage };
}

interface TemplateData {
  name: string;
  language: string;
  components?: Array<{
    type: 'header' | 'body' | 'button';
    parameters?: Array<{ type: string; text?: string }>;
  }>;
  bodyText?: string;
}

interface ExplicitTemplateConfig {
  templateId: string;
  templateName: string;
  variables: Record<string, string>;
}

interface FollowUpTemplateVariable {
  position: number;
  fieldMapping: string;
}

function resolveContactField(contact: any, business: any, fieldMapping: string): string {
  if (!contact && !business) return '';
  
  switch (fieldMapping) {
    case 'name':
      return contact?.name || 'Cliente';
    case 'phone':
      return contact?.phone || '';
    case 'email':
      return contact?.email || '';
    case 'businessName':
      return business?.name || 'Negocio';
    case 'tags':
      if (contact?.tags && Array.isArray(contact.tags) && contact.tags.length > 0) {
        return contact.tags[0];
      }
      return '';
    case 'leadStage':
      return contact?.leadStage || 'nuevo';
    case 'pendingOrderTotal':
      return '';
    default:
      return contact?.name || 'Cliente';
  }
}

async function getTemplateFromFollowUpConfig(
  config: any,
  contact: any,
  business: any
): Promise<{ template: TemplateData; isValid: boolean } | null> {
  if (!config?.templateEnabled || !config?.metaTemplateId) {
    return null;
  }
  
  const template = await prisma.metaTemplate.findUnique({
    where: { id: config.metaTemplateId }
  });
  
  if (!template || template.status !== 'APPROVED') {
    console.log(`[REMINDER] FollowUpConfig template ${config.metaTemplateId} not found or not approved`);
    return null;
  }
  
  let storedComponents: any[] = [];
  if (template.components) {
    if (typeof template.components === 'string') {
      try {
        storedComponents = JSON.parse(template.components);
      } catch {
        storedComponents = [];
      }
    } else if (Array.isArray(template.components)) {
      storedComponents = template.components;
    }
  }
  
  const templateVariables = (config.templateVariables || []) as FollowUpTemplateVariable[];
  const components: TemplateData['components'] = [];
  let allVariablesResolved = true;
  
  for (const comp of storedComponents) {
    const compType = comp.type?.toUpperCase();
    
    if ((compType === 'HEADER' || compType === 'BODY') && comp.text) {
      const matches = comp.text.match(/\{\{(\d+)\}\}/g) || [];
      
      if (matches.length > 0) {
        const parameters: Array<{ type: string; text: string }> = [];
        
        for (const match of matches) {
          const position = parseInt(match.replace(/[{}]/g, ''));
          const varConfig = templateVariables.find(v => v.position === position);
          
          let value = '';
          if (varConfig) {
            value = resolveContactField(contact, business, varConfig.fieldMapping);
          }
          
          if (!value) {
            value = contact?.name || 'Cliente';
          }
          
          if (!value || value.trim() === '') {
            console.log(`[REMINDER] Could not resolve variable {{${position}}} for template ${template.name}`);
            allVariablesResolved = false;
            value = 'Cliente';
          }
          
          parameters.push({ type: 'text', text: value });
        }
        
        components.push({
          type: compType.toLowerCase() as 'header' | 'body',
          parameters
        });
      }
    }
  }
  
  console.log(`[REMINDER] Resolved template ${template.name} with variables:`, 
    components.map(c => c.parameters?.map(p => p.text))
  );
  
  return {
    template: {
      name: template.name,
      language: template.language,
      components: components.length > 0 ? components : undefined,
      bodyText: template.bodyText || undefined
    },
    isValid: allVariablesResolved
  };
}

async function getExplicitlyConfiguredTemplate(
  reminder: any,
  contact: any
): Promise<{ template: TemplateData; isValid: boolean } | null> {
  const templateConfig = reminder.templateConfig as ExplicitTemplateConfig | null;
  
  if (!templateConfig || !templateConfig.templateId) {
    return null;
  }
  
  const template = await prisma.metaTemplate.findUnique({
    where: { id: templateConfig.templateId }
  });
  
  if (!template || template.status !== 'APPROVED') {
    console.log(`[REMINDER] Configured template ${templateConfig.templateId} not found or not approved`);
    return null;
  }
  
  let storedComponents: any[] = [];
  if (template.components) {
    if (typeof template.components === 'string') {
      try {
        storedComponents = JSON.parse(template.components);
      } catch {
        storedComponents = [];
      }
    } else if (Array.isArray(template.components)) {
      storedComponents = template.components;
    }
  }
  
  const components: TemplateData['components'] = [];
  let allVariablesResolved = true;
  
  for (const comp of storedComponents) {
    const compType = comp.type?.toUpperCase();
    
    if ((compType === 'HEADER' || compType === 'BODY') && comp.text) {
      const matches = comp.text.match(/\{\{(\d+)\}\}/g) || [];
      
      if (matches.length > 0) {
        const parameters: Array<{ type: string; text: string }> = [];
        
        for (let i = 0; i < matches.length; i++) {
          const varKey = `${compType.toLowerCase()}_${i + 1}`;
          let value = templateConfig.variables?.[varKey];
          
          if (!value && contact) {
            if (varKey.includes('1')) {
              value = contact.name || contact.phone;
            }
          }
          
          if (!value) {
            console.log(`[REMINDER] Missing variable ${varKey} for template ${template.name}`);
            allVariablesResolved = false;
            value = '';
          }
          
          parameters.push({ type: 'text', text: value });
        }
        
        components.push({
          type: compType.toLowerCase() as 'header' | 'body',
          parameters
        });
      }
    }
  }
  
  return {
    template: {
      name: template.name,
      language: template.language,
      components: components.length > 0 ? components : undefined,
      bodyText: template.bodyText || undefined
    },
    isValid: allVariablesResolved
  };
}

function validateTemplateBeforeSend(template: TemplateData): { valid: boolean; reason?: string } {
  if (!template.name || !template.language) {
    return { valid: false, reason: 'Template missing name or language' };
  }
  
  if (template.components) {
    for (const comp of template.components) {
      if (comp.parameters) {
        for (const param of comp.parameters) {
          if (!param.text || param.text.trim() === '') {
            return { valid: false, reason: `Empty parameter in ${comp.type} component` };
          }
          
          if (param.text.includes('{{') && param.text.includes('}}')) {
            return { valid: false, reason: `Unresolved placeholder in ${comp.type}: ${param.text}` };
          }
        }
      }
    }
  }
  
  return { valid: true };
}

async function generateFollowUpMessage(
  businessId: string,
  contactPhone: string,
  attemptNumber: number,
  pressureLevel: number
): Promise<string> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: { agentPrompts: true }
  });
  
  if (!business || !isOpenAIConfigured()) {
    const templates = [
      'Hola! Solo queria dar seguimiento a nuestra conversacion anterior. Tienes alguna pregunta?',
      'Hola! Me gustaria saber si pudiste revisar la informacion que te envie. Estoy aqui para ayudarte.',
      'Hola! Espero que estes bien. Solo queria recordarte que estamos disponibles si necesitas algo.'
    ];
    return templates[Math.min(attemptNumber - 1, templates.length - 1)];
  }
  
  const [recentMessages, contact, pendingOrders, totalMessageCount] = await Promise.all([
    prisma.messageLog.findMany({
      where: {
        businessId,
        OR: [{ sender: contactPhone }, { recipient: contactPhone }]
      },
      orderBy: { createdAt: 'desc' },
      take: 10
    }),
    prisma.contact.findFirst({
      where: { businessId, phone: contactPhone }
    }),
    prisma.order.count({
      where: {
        businessId,
        contactPhone: contactPhone,
        status: { in: ['PENDING_PAYMENT', 'AWAITING_VOUCHER', 'PAID', 'PROCESSING'] }
      }
    }),
    prisma.messageLog.count({
      where: {
        businessId,
        OR: [{ sender: contactPhone }, { recipient: contactPhone }]
      }
    })
  ]);
  
  const conversationContext = recentMessages
    .reverse()
    .map(m => `${m.direction === 'inbound' ? 'Cliente' : 'Agente'}: ${m.message}`)
    .join('\n');
  
  const contactContext: string[] = [];
  
  if (contact) {
    if (contact.tags && contact.tags.length > 0) {
      contactContext.push(`Tags: ${contact.tags.join(', ')}`);
    }
    if (contact.notes) {
      contactContext.push(`Notas: ${contact.notes.substring(0, 100)}`);
    }
  }
  
  if (pendingOrders > 0) {
    contactContext.push(`Tiene ${pendingOrders} pedido(s) pendiente(s)`);
  }
  
  contactContext.push(`Total de mensajes intercambiados: ${totalMessageCount}`);
  
  let engagementLevel = 'nuevo';
  if (totalMessageCount > 50) engagementLevel = 'cliente frecuente';
  else if (totalMessageCount > 20) engagementLevel = 'cliente regular';
  else if (totalMessageCount > 5) engagementLevel = 'cliente en desarrollo';
  
  contactContext.push(`Nivel de engagement: ${engagementLevel}`);
  
  const pressureDescriptions = [
    'muy sutil y amigable, solo un recordatorio casual',
    'amigable pero mostrando interes genuino en ayudar',
    'directo y profesional, enfatizando el valor de la oferta',
    'con sentido de urgencia moderado',
    'enfatizando escasez u oportunidad limitada'
  ];
  
  const pressureDesc = pressureDescriptions[Math.min(pressureLevel - 1, 4)];
  
  const modelConfig = await getModelForAgent('v1', business.openaiModel);
  
  const enrichedContext = contactContext.length > 0 
    ? `\n\nContexto del cliente:\n${contactContext.join('\n')}`
    : '';
  
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Eres un asistente de ventas de ${business.name}. 
Genera un mensaje de seguimiento corto (1-2 oraciones) para un cliente que no ha respondido.
Este es el intento #${attemptNumber} de contacto.
El tono debe ser: ${pressureDesc}.
El mensaje debe continuar naturalmente la conversacion anterior.
Adapta tu enfoque segun el contexto del cliente (etapa del lead, nivel de engagement, pedidos pendientes).
NO uses saludos largos. NO uses emojis. Maximo 50 palabras.`
    },
    {
      role: 'user',
      content: `Conversacion reciente:\n${conversationContext || 'Sin mensajes previos'}${enrichedContext}\n\nGenera el mensaje de seguimiento:`
    }
  ];
  
  const result = await callOpenAI({
    model: modelConfig.model,
    messages,
    reasoningEffort: modelConfig.reasoningEffort,
    maxTokens: 150,
    temperature: 0.7,
    maxHistoryTokens: 1000,
    context: {
      businessId,
      userId: business.userId,
      feature: 'follow_up'
    }
  });
  
  return result.content || 'Hola! Tienes alguna pregunta?';
}

async function isWithinAllowedHours(config: any, timezone: string = 'America/Lima'): Promise<boolean> {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
    weekday: 'short'
  });
  
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
  const weekday = parts.find(p => p.type === 'weekday')?.value || '';
  
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  
  if (!config.weekendsEnabled && isWeekend) {
    return false;
  }
  
  return hour >= config.allowedStartHour && hour < config.allowedEndHour;
}

async function getTodayAttemptCount(businessId: string, contactPhone: string): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  return prisma.reminder.count({
    where: {
      businessId,
      contactPhone,
      status: 'executed',
      executedAt: { gte: today }
    }
  });
}

const MAX_RETRY_ATTEMPTS = 3;
const PROCESSING_TIMEOUT_MS = 120000;

export async function processReminders(): Promise<void> {
  const now = new Date();
  const processingTimeout = new Date(now.getTime() - PROCESSING_TIMEOUT_MS);
  
  const pendingReminders = await prisma.reminder.findMany({
    where: {
      status: 'pending',
      scheduledAt: { lte: now },
      OR: [
        { processingAt: null },
        { processingAt: { lt: processingTimeout } }
      ]
    },
    include: {
      business: {
        include: {
          instances: true,
          followUpConfigs: true
        }
      }
    },
    orderBy: { scheduledAt: 'asc' },
    take: 50
  });
  
  if (pendingReminders.length > 0) {
    console.log(`[REMINDER] Found ${pendingReminders.length} pending reminders to process`);
  }
  
  for (const reminder of pendingReminders) {
    const claimTime = new Date();
    const claimTimeout = new Date(claimTime.getTime() - PROCESSING_TIMEOUT_MS);
    
    const claimed = await prisma.reminder.updateMany({
      where: {
        id: reminder.id,
        status: 'pending',
        OR: [
          { processingAt: null },
          { processingAt: { lt: claimTimeout } }
        ]
      },
      data: { processingAt: claimTime }
    });
    
    if (claimed.count === 0) {
      console.log(`[REMINDER] Reminder ${reminder.id} already claimed by another worker`);
      continue;
    }
    
    try {
      const freshReminder = await prisma.reminder.findUnique({
        where: { id: reminder.id }
      });
      if (!freshReminder) continue;
      
      const config = reminder.business.followUpConfigs?.find(c => 
        c.instanceId === reminder.instanceId || !c.instanceId
      ) || reminder.business.followUpConfigs?.[0];
      
      if (config && !config.enabled && reminder.type === 'auto') {
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { status: 'skipped', processingAt: null }
        });
        continue;
      }
      
      const businessTimezone = reminder.business.timezone || 'America/Lima';
      
      if (config && !(await isWithinAllowedHours(config, businessTimezone))) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(config.allowedStartHour, 0, 0, 0);
        
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { scheduledAt: tomorrow, processingAt: null }
        });
        console.log(`[REMINDER] Rescheduled ${reminder.id} to ${tomorrow.toISOString()} (outside allowed hours)`);
        continue;
      }
      
      if (config) {
        const todayAttempts = await getTodayAttemptCount(reminder.businessId, reminder.contactPhone);
        if (todayAttempts >= config.maxDailyAttempts) {
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: { status: 'max_daily_reached', processingAt: null }
          });
          continue;
        }
      }
      
      const instance = await getActiveInstance(reminder.businessId);
      if (!instance) {
        const retryAt = new Date(Date.now() + 15 * 60 * 1000);
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { scheduledAt: retryAt, processingAt: null }
        });
        console.log(`[REMINDER] No active WhatsApp instance for business ${reminder.businessId} - rescheduled ${reminder.id} for ${retryAt.toISOString()}`);
        continue;
      }
      
      console.log(`[REMINDER] Processing reminder ${reminder.id} for ${reminder.contactPhone} via ${instance.provider} (instance: ${instance.id})`);
      
      const windowStatus = await checkWindowStatus(reminder.businessId, reminder.contactPhone);
      
      let message = reminder.messageTemplate || reminder.generatedMessage;
      let usedTemplate: TemplateData | null = null;
      
      console.log(`[REMINDER] Window status for ${reminder.contactPhone}: requiresTemplate=${windowStatus.requiresTemplate}, provider=${windowStatus.provider}, hours=${windowStatus.hoursSinceLastMessage}`);
      
      if (windowStatus.requiresTemplate && windowStatus.provider === 'META_CLOUD') {
        const contact = await prisma.contact.findFirst({
          where: { businessId: reminder.businessId, phone: reminder.contactPhone }
        });
        
        const configTemplate = await getTemplateFromFollowUpConfig(config, contact, reminder.business);
        
        if (configTemplate) {
          const validation = validateTemplateBeforeSend(configTemplate.template);
          if (!validation.valid) {
            console.log(`[REMINDER] FollowUpConfig template validation failed for reminder ${reminder.id}: ${validation.reason}`);
            await prisma.reminder.update({
              where: { id: reminder.id },
              data: { 
                status: 'template_error',
                lastError: `Template validation failed: ${validation.reason}`,
                processingAt: null 
              }
            });
            continue;
          }
          
          usedTemplate = configTemplate.template;
          message = usedTemplate.bodyText || `[Template: ${usedTemplate.name}]`;
          console.log(`[REMINDER] Using FollowUpConfig template: ${usedTemplate.name}`);
        } else {
          const explicitTemplate = await getExplicitlyConfiguredTemplate(reminder, contact);
          
          if (explicitTemplate) {
            const validation = validateTemplateBeforeSend(explicitTemplate.template);
            if (!validation.valid) {
              console.log(`[REMINDER] Template validation failed for reminder ${reminder.id}: ${validation.reason}`);
              await prisma.reminder.update({
                where: { id: reminder.id },
                data: { 
                  status: 'template_error',
                  lastError: `Template validation failed: ${validation.reason}`,
                  processingAt: null 
                }
              });
              continue;
            }
            
            usedTemplate = explicitTemplate.template;
            message = usedTemplate.bodyText || `[Template: ${usedTemplate.name}]`;
            console.log(`[REMINDER] Using explicitly configured template: ${usedTemplate.name}`);
          } else {
            console.log(`[REMINDER] No template configured for reminder ${reminder.id} - cannot send outside 24h window`);
            await prisma.reminder.update({
              where: { id: reminder.id },
              data: { 
                status: 'no_template',
                lastError: 'No template configured - 24h window closed. Configure a template in Seguimientos > Plantilla Meta',
                processingAt: null 
              }
            });
            continue;
          }
        }
        
      } else if (!message) {
        let pressureLevel = config?.pressureLevel || 1;
        
        if (config && Array.isArray(config.followUpSteps)) {
          const stepIndex = reminder.attemptNumber - 1;
          const step = (config.followUpSteps as any[])[stepIndex];
          if (step && typeof step.pressureLevel === 'number') {
            pressureLevel = step.pressureLevel;
          }
        }
        
        message = await generateFollowUpMessage(
          reminder.businessId,
          reminder.contactPhone,
          reminder.attemptNumber,
          pressureLevel
        );
        console.log(`[REMINDER] Generated follow-up message for attempt #${reminder.attemptNumber} with pressure ${pressureLevel}`);
      }
      
      const cleanPhone = reminder.contactPhone.replace(/\D/g, '');
      
      if (instance.provider === 'META_CLOUD' || instance.provider === 'META_COEXIST') {
        const isCoexist = instance.provider === 'META_COEXIST';
        
        let accessToken: string;
        let phoneNumberId: string;
        let metaBusinessId: string;
        
        if (isCoexist) {
          const coexistCred = instance.metaCoexistCredential || await prisma.metaCoexistCredential.findFirst({
            where: { instanceId: instance.id }
          });
          
          if (!coexistCred) {
            console.log(`[REMINDER] No Meta Coexist credentials for instance ${instance.id} - rescheduling`);
            const retryAt = new Date(Date.now() + 15 * 60 * 1000);
            await prisma.reminder.update({
              where: { id: reminder.id },
              data: { scheduledAt: retryAt, processingAt: null }
            });
            continue;
          }
          
          accessToken = coexistCred.systemAccessToken || coexistCred.userAccessToken;
          phoneNumberId = coexistCred.phoneNumberId;
          metaBusinessId = coexistCred.metaBusinessId;
        } else {
          const metaCred = instance.metaCredential || await prisma.metaCredential.findFirst({
            where: { instanceId: instance.id }
          });
          
          if (!metaCred) {
            console.log(`[REMINDER] No Meta credentials for instance ${instance.id} - rescheduling`);
            const retryAt = new Date(Date.now() + 15 * 60 * 1000);
            await prisma.reminder.update({
              where: { id: reminder.id },
              data: { scheduledAt: retryAt, processingAt: null }
            });
            continue;
          }
          
          accessToken = metaCred.accessToken;
          phoneNumberId = metaCred.phoneNumberId;
          metaBusinessId = metaCred.businessId;
        }
        
        console.log(`[REMINDER] Sending via ${isCoexist ? 'Meta Coexist' : 'Meta Cloud'} to ${cleanPhone}`);
        
        const metaService = new MetaCloudService({
          accessToken,
          phoneNumberId,
          businessId: metaBusinessId
        });
        
        if (usedTemplate) {
          const finalValidation = validateTemplateBeforeSend(usedTemplate);
          if (!finalValidation.valid) {
            console.error(`[REMINDER] BLOCKED: Template failed final validation: ${finalValidation.reason}`);
            await prisma.reminder.update({
              where: { id: reminder.id },
              data: { 
                status: 'template_error',
                lastError: `Final validation failed: ${finalValidation.reason}`,
                processingAt: null 
              }
            });
            continue;
          }
          
          await metaService.sendTemplate({
            to: cleanPhone,
            templateName: usedTemplate.name,
            language: usedTemplate.language,
            components: usedTemplate.components
          });
          console.log(`[REMINDER] Template sent successfully to ${cleanPhone}`);
        } else {
          const cleanedMessage = cleanMarkdownForWhatsApp(message);
          await metaService.sendMessage({ to: cleanPhone, text: cleanedMessage });
          console.log(`[REMINDER] Message sent successfully to ${cleanPhone}`);
        }
      } else {
        if (!instance.instanceBackendId) {
          console.log(`[REMINDER] No Baileys backend ID for instance ${instance.id} - rescheduling`);
          const retryAt = new Date(Date.now() + 15 * 60 * 1000);
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: { scheduledAt: retryAt, processingAt: null }
          });
          continue;
        }
        
        const cleanedMessage = cleanMarkdownForWhatsApp(message);
        await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/sendMessage`, {
          to: cleanPhone.includes('@') ? cleanPhone : `${cleanPhone}@s.whatsapp.net`,
          message: cleanedMessage
        });
      }
      
      await prisma.messageLog.create({
        data: {
          businessId: reminder.businessId,
          instanceId: instance.id,
          direction: 'outbound',
          recipient: cleanPhone,
          message,
          metadata: {
            type: 'reminder',
            reminderId: reminder.id,
            attemptNumber: reminder.attemptNumber,
            provider: instance.provider,
            usedTemplate: usedTemplate?.name || null
          }
        }
      });
      
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          status: 'executed',
          executedAt: new Date(),
          processingAt: null,
          generatedMessage: message
        }
      });
      
      console.log(`[REMINDER] Executed: ${reminder.id} to ${cleanPhone} via ${instance.provider}${usedTemplate ? ` (template: ${usedTemplate.name})` : ''}${freshReminder.retryCount > 0 ? ` (after ${freshReminder.retryCount} retries)` : ''}`);
      
    } catch (error: any) {
      let errorMessage = error?.message || 'Unknown error';
      let metaErrorDetails = null;
      
      if (error?.response?.data) {
        metaErrorDetails = error.response.data;
        errorMessage = `Meta API Error: ${JSON.stringify(metaErrorDetails)}`;
      }
      
      const latestReminder = await prisma.reminder.findUnique({ where: { id: reminder.id } });
      const currentRetryCount = latestReminder?.retryCount || 0;
      const shouldRetry = currentRetryCount < MAX_RETRY_ATTEMPTS;
      
      console.error(`[REMINDER] Failed to process reminder ${reminder.id} (retry ${currentRetryCount + 1}/${MAX_RETRY_ATTEMPTS}):`, {
        error: errorMessage,
        contactPhone: reminder.contactPhone,
        businessId: reminder.businessId,
        provider: reminder.business.instances[0]?.provider,
        metaError: metaErrorDetails,
        willRetry: shouldRetry
      });
      
      if (shouldRetry) {
        const retryDelayMs = Math.pow(4, currentRetryCount) * 2 * 60 * 1000;
        const nextRetryAt = new Date(Date.now() + retryDelayMs);
        
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { 
            retryCount: currentRetryCount + 1,
            lastError: errorMessage,
            processingAt: null,
            scheduledAt: nextRetryAt
          }
        });
        
        console.log(`[REMINDER] Scheduled retry for ${reminder.id} at ${nextRetryAt.toISOString()}`);
      } else {
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: {
            status: 'failed',
            executedAt: new Date(),
            lastError: errorMessage,
            processingAt: null
          }
        });
        console.log(`[REMINDER] Max retries reached for ${reminder.id} - marked as failed`);
      }
    }
  }
}

let workerInterval: NodeJS.Timeout | null = null;

export function startReminderWorker(intervalMs: number = 30000): void {
  if (workerInterval) {
    console.log('[REMINDER] Worker already running');
    return;
  }
  
  console.log(`[REMINDER] Starting worker (event-driven mode)...`);
  
  processReminders().then(() => {
    console.log('[REMINDER] Initial check complete. Stats:', getReminderStats());
  }).catch(err => {
    console.error('[REMINDER] Initial check failed:', err);
  });
  
  workerInterval = setInterval(async () => {
    try {
      await processReminders();
    } catch (error) {
      console.error('[REMINDER] Worker error:', error);
    }
  }, intervalMs);
}

export function stopReminderWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('[REMINDER] Worker stopped');
  }
}

async function getReminderStats() {
  const [pending, executed, failed, retryPending] = await Promise.all([
    prisma.reminder.count({ where: { status: 'pending' } }),
    prisma.reminder.count({ where: { status: 'executed' } }),
    prisma.reminder.count({ where: { status: 'failed' } }),
    prisma.reminder.count({ where: { status: 'pending', retryCount: { gt: 0 } } })
  ]);
  
  return { pending, executed, failed, retryPending };
}

export async function getReminderStatsForBusiness(businessId: string) {
  const [pending, executed, failed, skipped] = await Promise.all([
    prisma.reminder.count({ where: { businessId, status: 'pending' } }),
    prisma.reminder.count({ where: { businessId, status: 'executed' } }),
    prisma.reminder.count({ where: { businessId, status: 'failed' } }),
    prisma.reminder.count({ where: { businessId, status: 'skipped' } })
  ]);
  
  return { pending, executed, failed, skipped };
}

export async function getFailedRemindersDetails(businessId: string) {
  return prisma.reminder.findMany({
    where: { businessId, status: 'failed' },
    orderBy: { executedAt: 'desc' },
    take: 50
  });
}

export async function retryFailedReminder(reminderId: string): Promise<boolean> {
  const reminder = await prisma.reminder.findUnique({
    where: { id: reminderId }
  });
  
  if (!reminder || reminder.status !== 'failed') {
    return false;
  }
  
  await prisma.reminder.update({
    where: { id: reminderId },
    data: {
      status: 'pending',
      scheduledAt: new Date(),
      retryCount: 0,
      executedAt: null,
      lastError: null,
      processingAt: null
    }
  });
  
  return true;
}

import prisma from './prisma.js';
import axios from 'axios';
import { geminiService } from './gemini.js';
import { assignNextRoundRobinAdvisor } from '../routes/advisor.js';
import { cancelPendingFollowUps } from './followUpService.js';
import { logTokenUsage } from './tokenLogger.js';
import { processAutoTriggers, TriggerContext } from './autoTriggers.js';

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';
const INTERNAL_AGENT_SECRET = process.env.INTERNAL_AGENT_SECRET || 'internal-agent-secret-change-me';

// Environment detection for debugging
const IS_REPLIT = process.env.REPL_ID ? true : false;
const ENV_NAME = IS_REPLIT ? 'REPLIT' : 'PRODUCTION';

function logIngest(tag: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const envTag = `[${ENV_NAME}]`;
  const fullTag = `[INGEST-${tag}]`;
  if (data) {
    console.log(`${timestamp} ${envTag} ${fullTag} ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`${timestamp} ${envTag} ${fullTag} ${message}`);
  }
}

export interface IncomingMessage {
  businessId: string;
  instanceId: string;
  provider: 'BAILEYS' | 'META_CLOUD' | 'META_COEXIST' | 'META_MANAGED';
  from: string;
  pushName: string;
  messageId: string;
  timestamp: number;
  type: string;
  text?: string;
  mediaUrl?: string;
  mimetype?: string;
  caption?: string;
  filename?: string;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contextMessageId?: string;
  contacts?: Array<{ name: string; phones: string[] }>;
  buttonPayload?: string;
  interactiveId?: string;
  reaction?: { messageId: string; emoji: string };
  order?: { catalogId: string; items: Array<{ productId: string; quantity: number; price: number; currency: string }> };
  skipAI?: boolean; // Skip AI processing when media is pending async download
}

export async function processIncomingMessage(message: IncomingMessage): Promise<boolean> {
  const { businessId, instanceId, provider, from, pushName, type, text, mediaUrl, caption } = message;

  const cleanPhone = from.replace(/\D/g, '');
  
  // DEDUPLICATION: Check if message already processed using providerMessageId
  const providerMessageId = message.messageId;
  if (providerMessageId) {
    const existingMessage = await prisma.messageLog.findFirst({
      where: {
        businessId,
        providerMessageId
      }
    });
    
    if (existingMessage) {
      console.log(`[DEDUP] Message ${providerMessageId} already processed, skipping`);
      return false;
    }
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      agentPrompts: {
        include: { tools: { where: { enabled: true } } }
      },
      policy: true,
      products: true
    }
  });

  if (!business) {
    console.error('Business not found:', businessId);
    return false;
  }

  let messageText = text || caption || '';
  
  // Handle special message types
  if (type === 'location' && message.location) {
    messageText = `Ubicación: ${message.location.latitude}, ${message.location.longitude}`;
    if (message.location.name) messageText += ` (${message.location.name})`;
    if (message.location.address) messageText += ` - ${message.location.address}`;
  }
  
  // Handle catalog order messages
  if (type === 'order' && message.order) {
    const orderItems = message.order.items.map(item => 
      `• ${item.productId} x${item.quantity} - ${item.currency} ${item.price.toFixed(2)}`
    ).join('\n');
    const totalAmount = message.order.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const currency = message.order.items[0]?.currency || 'USD';
    
    messageText = `🛒 PEDIDO DEL CATÁLOGO DE WHATSAPP\n` +
      `Catálogo: ${message.order.catalogId}\n` +
      `Productos:\n${orderItems}\n` +
      `Total: ${currency} ${totalAmount.toFixed(2)}`;
    
    console.log(`[ORDER] Catalog order received from ${cleanPhone}:`, JSON.stringify(message.order, null, 2));
  }

  let mediaAnalysis = '';
  let mediaAnalysisRaw = '';
  if (mediaUrl && geminiService.isConfigured()) {
    const mediaTypes = ['audio', 'ptt', 'image', 'sticker', 'video'];
    if (mediaTypes.includes(type)) {
      console.log(`[GEMINI] Processing ${type} for AI context...`);
      const result = await geminiService.processMedia(mediaUrl, type, messageText);
      if (result.success && result.text) {
        mediaAnalysisRaw = result.text;
        if (type === 'audio' || type === 'ptt') {
          if (!messageText) {
            messageText = result.text;
          }
          mediaAnalysis = `\n\n[SISTEMA - Transcripción automática del audio enviado por el cliente: "${result.text}"]`;
        } else if (type === 'image' || type === 'sticker') {
          mediaAnalysis = `\n\n[SISTEMA - El cliente envió una imagen. Descripción automática: ${result.text}]`;
        } else if (type === 'video') {
          mediaAnalysis = `\n\n[SISTEMA - El cliente envió un video. Descripción automática: ${result.text}]`;
        }
        console.log(`[GEMINI] Media analysis complete for ${type}`);
      }
    }
  }

  // ============================================
  // AUTO-TRIGGER SYSTEM: Intelligent Voucher & Order Processing
  // ============================================
  // This system detects triggers (voucher received, purchase confirmed) 
  // and executes required actions BEFORE the AI agent processes the message.
  // This ensures the AI agent receives accurate context about completed actions.
  
  let voucherContext = '';
  let voucherValidationData: any = null;
  let autoTriggerContext = '';
  
  if (type === 'image' && mediaUrl && geminiService.isConfigured()) {
    const normalizedOrderPhone = from.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '').replace(/\D/g, '');
    
    logIngest('AUTO-TRIGGER', `Processing image - checking for voucher`, { phone: normalizedOrderPhone });
    
    try {
      // Step 1: Always validate if image is a payment voucher (regardless of existing order)
      const voucherValidation = await geminiService.validatePaymentVoucher(
        mediaUrl,
        { currency: business.currencyCode || 'PEN' }
      );
      
      logIngest('AUTO-TRIGGER', `Gemini voucher validation result`, {
        isPaymentProof: voucherValidation.isPaymentProof,
        isValid: voucherValidation.isValid,
        brand: voucherValidation.brand,
        amount: voucherValidation.amount
      });
      
      // Step 2: If it's a valid voucher, use auto-trigger system
      if (voucherValidation.isPaymentProof && voucherValidation.isValid) {
        const triggerContext: TriggerContext = {
          businessId,
          instanceId,
          contactPhone: normalizedOrderPhone,
          contactName: pushName,
          messageText,
          mediaUrl,
          mediaType: type,
          mediaAnalysis,
          geminiVoucherResult: {
            isPaymentProof: voucherValidation.isPaymentProof,
            isValid: voucherValidation.isValid,
            brand: voucherValidation.brand,
            amount: voucherValidation.amount,
            currency: voucherValidation.currency,
            operationCode: voucherValidation.operationCode,
            confidence: voucherValidation.confidence,
            imageUrl: mediaUrl
          }
        };
        
        const triggerResult = await processAutoTriggers(triggerContext);
        
        logIngest('AUTO-TRIGGER', `Trigger result`, {
          trigger: triggerResult.trigger,
          executed: triggerResult.executed,
          error: triggerResult.error
        });
        
        if (triggerResult.contextForAgent) {
          autoTriggerContext = '\n\n' + triggerResult.contextForAgent;
          // Append trigger context to existing media analysis instead of replacing
          // This preserves the original Gemini image description if present
          const originalMediaAnalysis = mediaAnalysis || '';
          mediaAnalysis = originalMediaAnalysis + autoTriggerContext;
          mediaAnalysisRaw = (mediaAnalysisRaw || '') + ` [AUTO-TRIGGER: ${triggerResult.trigger}] ${triggerResult.executed ? 'Executed' : 'Not executed'} - ${triggerResult.error || 'OK'}`;
          
          if (triggerResult.result) {
            voucherValidationData = {
              ...voucherValidation,
              autoTrigger: {
                type: triggerResult.trigger,
                executed: triggerResult.executed,
                result: triggerResult.result
              }
            };
          }
        }
        
        await logTokenUsage({
          userId: business.userId,
          businessId,
          feature: 'voucher_validation',
          model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
          promptTokens: 258,
          completionTokens: 128,
          provider: 'gemini'
        });
        
      } else {
        logIngest('AUTO-TRIGGER', `Image is not a payment voucher`, {
          isPaymentProof: voucherValidation.isPaymentProof,
          isValid: voucherValidation.isValid,
          reason: voucherValidation.reason
        });
      }
    } catch (voucherError: any) {
      console.error(`[AUTO-TRIGGER] Error processing image trigger:`, voucherError.message);
    }
  }
  
  // Also check for text-based purchase confirmation triggers (even without images)
  if (!autoTriggerContext && messageText) {
    const normalizedOrderPhone = from.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '').replace(/\D/g, '');
    
    const triggerContext: TriggerContext = {
      businessId,
      instanceId,
      contactPhone: normalizedOrderPhone,
      contactName: pushName,
      messageText,
      mediaUrl,
      mediaType: type
    };
    
    try {
      const triggerResult = await processAutoTriggers(triggerContext);
      
      // Always inject context when available, even if trigger was not executed
      // (e.g., purchase confirmation with missing data needs guidance)
      if (triggerResult.contextForAgent) {
        autoTriggerContext = '\n\n' + triggerResult.contextForAgent;
        
        logIngest('AUTO-TRIGGER', `Text trigger processed`, {
          trigger: triggerResult.trigger,
          executed: triggerResult.executed,
          hasContext: true
        });
      }
    } catch (triggerError: any) {
      console.error(`[AUTO-TRIGGER] Error processing text trigger:`, triggerError.message);
    }
  }

  // Build full message for AI agent, including auto-trigger context if available
  const fullMessageForAgent = messageText + mediaAnalysis + (autoTriggerContext && !mediaAnalysis.includes(autoTriggerContext) ? autoTriggerContext : '');

  await prisma.messageLog.create({
    data: {
      businessId,
      instanceId,
      direction: 'inbound',
      sender: cleanPhone,
      recipient: business.name,
      message: messageText,
      mediaUrl,
      providerMessageId: providerMessageId || undefined,
      metadata: {
        pushName,
        type,
        provider,
        messageId: message.messageId,
        timestamp: message.timestamp,
        mediaAnalysis: mediaAnalysisRaw || undefined,
        mediaType: mediaUrl ? type : undefined,
        order: message.order || undefined,
        voucherValidation: voucherValidationData || undefined,
        voucherContext: voucherContext || undefined
      }
    }
  });

  const now = new Date();
  try {
    await prisma.contact.upsert({
      where: {
        businessId_phone: { businessId, phone: cleanPhone }
      },
      create: {
        businessId,
        phone: cleanPhone,
        name: pushName || null,
        source: provider,
        firstMessageAt: now,
        lastMessageAt: now,
        messageCount: 1
      },
      update: {
        name: pushName || undefined,
        lastMessageAt: now,
        messageCount: { increment: 1 }
      }
    });
  } catch (err) {
    console.error('[CONTACT] Failed to upsert contact:', err);
  }

  try {
    await assignNextRoundRobinAdvisor(businessId, cleanPhone);
  } catch (err) {
    console.error('[ROUND-ROBIN] Failed to assign advisor:', err);
  }

  // Cancel any pending follow-up reminders when user sends a message
  await cancelPendingFollowUps(businessId, cleanPhone);

  const contact = await prisma.contact.findUnique({
    where: {
      businessId_phone: { businessId, phone: cleanPhone }
    }
  });

  // Bot testing mode: Allow bot response for specific contacts even when globally disabled
  if (!business.botEnabled) {
    if (contact?.botTestEnabled) {
      console.log('[BOT TEST MODE] Bot globally disabled but test mode enabled for contact:', cleanPhone);
    } else {
      console.log('Bot disabled for business:', businessId);
      return true;
    }
  }

  // Per-contact bot disable (only applies when bot is globally enabled)
  if (business.botEnabled && contact?.botDisabled) {
    console.log('Bot disabled for contact:', cleanPhone, 'in business:', businessId);
    return true;
  }

  // Skip AI processing if media is pending async download
  // The mediaDownloadProcessor will call AI after media is ready
  if (message.skipAI) {
    console.log(`[MESSAGE_INGEST] Skipping AI for ${cleanPhone} - media pending async download`);
    return true;
  }

  const CORE_API_URL = process.env.CORE_API_URL || 'http://localhost:3001';
  try {
    await axios.post(`${CORE_API_URL}/agent/think`, {
      business_id: businessId,
      instanceId,
      provider,
      phone: `${cleanPhone}@s.whatsapp.net`,
      phoneNumber: cleanPhone,
      contactName: pushName,
      user_message: fullMessageForAgent,
      mediaUrl,
      mediaAnalysis: mediaAnalysis || undefined,
      providerMessageId: providerMessageId || undefined
    }, {
      headers: { 'X-Internal-Secret': INTERNAL_AGENT_SECRET }
    });
    return true;
  } catch (error: any) {
    console.error('Failed to process with AI agent:', error.message);
    return false;
  }
}

export async function sendProviderMessage(options: {
  businessId: string;
  instanceId: string;
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'document';
  caption?: string;
  filename?: string;
}): Promise<boolean> {
  const { businessId, instanceId, to, text, mediaUrl, mediaType, caption, filename } = options;

  const instance = await prisma.whatsAppInstance.findUnique({
    where: { id: instanceId },
    include: { 
      metaCredential: true,
      metaCoexistCredential: true
    }
  });

  if (!instance) {
    console.error('Instance not found:', instanceId);
    return false;
  }

  const cleanPhone = to.replace(/\D/g, '');

  try {
    if (instance.provider === 'META_CLOUD') {
      if (!instance.metaCredential) {
        console.error('Meta credentials not found for instance:', instanceId);
        return false;
      }

      const { MetaCloudService } = await import('./metaCloud.js');
      const metaService = new MetaCloudService({
        accessToken: instance.metaCredential.accessToken,
        phoneNumberId: instance.metaCredential.phoneNumberId,
        businessId: instance.metaCredential.businessId
      });

      await metaService.sendMessage({
        to: cleanPhone,
        text,
        mediaUrl,
        mediaType,
        caption,
        filename
      });
    } else if (instance.provider === 'META_COEXIST') {
      if (!instance.metaCoexistCredential) {
        console.error('Meta Coexist credentials not found for instance:', instanceId);
        return false;
      }

      const { MetaCloudService } = await import('./metaCloud.js');
      const token = instance.metaCoexistCredential.systemAccessToken || instance.metaCoexistCredential.userAccessToken;
      const metaService = new MetaCloudService({
        accessToken: token,
        phoneNumberId: instance.metaCoexistCredential.phoneNumberId,
        businessId: instance.metaCoexistCredential.metaBusinessId
      });

      await metaService.sendMessage({
        to: cleanPhone,
        text,
        mediaUrl,
        mediaType,
        caption,
        filename
      });
    } else {
      const recipient = `${cleanPhone}@s.whatsapp.net`;

      if (mediaUrl && mediaType) {
        const endpoint = mediaType === 'image' ? 'sendImage' 
          : mediaType === 'video' ? 'sendVideo'
          : mediaType === 'audio' ? 'sendAudio'
          : 'sendFile';

        await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/${endpoint}`, {
          to: recipient,
          url: mediaUrl,
          caption: caption || text
        });
      } else if (text) {
        await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/sendMessage`, {
          to: recipient,
          message: text
        });
      }
    }

    await prisma.messageLog.create({
      data: {
        businessId,
        instanceId,
        direction: 'outbound',
        sender: 'bot',
        recipient: cleanPhone,
        message: text || caption || '',
        mediaUrl,
        metadata: { provider: instance.provider }
      }
    });

    return true;
  } catch (error: any) {
    console.error('Failed to send message via provider:', error.message);
    return false;
  }
}

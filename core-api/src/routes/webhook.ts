import { Router, Request, Response } from 'express';
import axios from 'axios';
import prisma from '../services/prisma.js';
import { analyzeAndUpdateLeadStage } from '../services/leadStageService.js';
import { processDataExtraction } from '../services/dataExtractionService.js';
import { checkAndAdvanceStage } from '../services/funnelStageService.js';
import { geminiService } from '../services/gemini.js';
import { logTokenUsage } from '../services/tokenLogger.js';
import { dispatchUserMessage } from '../services/webhookService.js';
import { getRedisConnection, isRedisAvailable } from '../services/redis.js';

const router = Router();
const CORE_API_URL = process.env.CORE_API_URL || 'http://localhost:3001';
const INTERNAL_AGENT_SECRET = process.env.INTERNAL_AGENT_SECRET || 'internal-agent-secret-change-me';

// Atomic deduplication for BAILEYS messages
const DEDUP_TTL_SECONDS = 300;
const processedBaileysMessages = new Map<string, number>();
const MAX_MEMORY_ENTRIES = 5000;

async function isBaileysMessageDuplicate(messageId: string): Promise<boolean> {
  if (!messageId) return false;
  
  const dedupKey = `baileys_webhook_dedup:${messageId}`;
  
  if (isRedisAvailable()) {
    try {
      const redis = getRedisConnection();
      const result = await redis.set(dedupKey, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
      if (result === null) {
        console.log(`[DEDUP-REDIS-BAILEYS] Message ${messageId} already processed, skipping`);
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[DEDUP-BAILEYS] Redis error, falling back to memory:', err);
    }
  }
  
  const now = Date.now();
  if (processedBaileysMessages.has(messageId)) {
    const timestamp = processedBaileysMessages.get(messageId)!;
    if (now - timestamp < DEDUP_TTL_SECONDS * 1000) {
      console.log(`[DEDUP-MEM-BAILEYS] Message ${messageId} already processed, skipping`);
      return true;
    }
  }
  
  if (processedBaileysMessages.size >= MAX_MEMORY_ENTRIES) {
    const cutoff = now - (DEDUP_TTL_SECONDS * 1000);
    let deleted = 0;
    for (const [key, ts] of processedBaileysMessages.entries()) {
      if (ts < cutoff) {
        processedBaileysMessages.delete(key);
        deleted++;
      }
      if (deleted >= 1000) break;
    }
  }
  
  processedBaileysMessages.set(messageId, now);
  return false;
}

async function processMediaWithGemini(
  mediaUrl: string, 
  mediaType: string, 
  businessId: string,
  userId: string
): Promise<string | null> {
  if (!geminiService.isConfigured()) {
    console.log('[WEBHOOK] Gemini not configured, skipping media processing');
    return null;
  }

  try {
    console.log(`[WEBHOOK] Processing ${mediaType} with Gemini:`, mediaUrl);
    const result = await geminiService.processMedia(mediaUrl, mediaType);
    
    if (result.success && result.text) {
      const featureMap: Record<string, string> = {
        'audio': 'audio_transcription',
        'ptt': 'audio_transcription',
        'image': 'image_analysis',
        'sticker': 'image_analysis',
        'video': 'video_analysis'
      };
      const feature = featureMap[mediaType] || 'media_processing';
      
      const inputTokensEstimate = mediaType === 'audio' || mediaType === 'ptt' ? 500 : 
                                  mediaType === 'video' ? 2000 : 258;
      const outputChars = result.text.length;
      const promptTokens = inputTokensEstimate;
      const completionTokens = Math.ceil(outputChars / 4);
      
      await logTokenUsage({
        userId,
        businessId,
        feature,
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
        promptTokens,
        completionTokens,
        provider: 'gemini'
      });
      
      console.log(`[WEBHOOK] ${mediaType} processed:`, result.text.substring(0, 100));
      return result.text;
    }
    
    return null;
  } catch (error: any) {
    console.error(`[WEBHOOK] Gemini ${mediaType} processing failed:`, error.message);
    return null;
  }
}

router.post('/:businessId', async (req: Request, res: Response) => {
  try {
    const { businessId } = req.params;
    const { event, payload, instanceId } = req.body;
    const data = payload;
    
    console.log(`Webhook received for business ${businessId}:`, event);
    console.log('Webhook payload:', JSON.stringify(payload, null, 2));
    
    // Log all Baileys webhook payloads to WebhookRawLog for debugging
    let rawLogId: string | null = null;
    try {
      const rawLog = await prisma.webhookRawLog.create({
        data: {
          source: 'BAILEYS',
          endpoint: `/webhook/${businessId}`,
          method: 'POST',
          headers: req.headers as any,
          body: req.body,
          businessId,
          instanceId: instanceId || null,
          messageCount: event === 'message.received' ? 1 : 0,
          statusCount: event === 'message.status' ? 1 : 0
        }
      });
      rawLogId = rawLog.id;
      console.log(`[WEBHOOK-RAW] Logged Baileys webhook: ${rawLogId}, event: ${event}`);
    } catch (logErr: any) {
      console.error('[WEBHOOK-RAW] Failed to log webhook:', logErr.message);
    }
    
    const business = await prisma.business.findUnique({
      where: { id: businessId }
    });
    
    if (!business) {
      console.log(`Business ${businessId} not found`);
      return res.status(404).json({ error: 'Business not found' });
    }
    
    switch (event) {
      case 'connection.open':
        // Update by instanceBackendId if available, otherwise fallback to businessId
        if (instanceId) {
          await prisma.whatsAppInstance.updateMany({
            where: { businessId, instanceBackendId: instanceId },
            data: { 
              status: 'open',
              isActive: true,
              lastConnection: new Date(),
              phoneNumber: data?.phoneNumber
            }
          });
          console.log(`[WEBHOOK] Instance ${instanceId} connected for business ${businessId}`);
        } else {
          await prisma.whatsAppInstance.updateMany({
            where: { businessId, provider: 'BAILEYS' },
            data: { 
              status: 'open',
              isActive: true,
              lastConnection: new Date(),
              phoneNumber: data?.phoneNumber
            }
          });
        }
        break;
        
      case 'connection.close':
        // Keep isActive true so instance can be restored on restart
        if (instanceId) {
          await prisma.whatsAppInstance.updateMany({
            where: { businessId, instanceBackendId: instanceId },
            data: { status: 'closed' }
          });
        } else {
          await prisma.whatsAppInstance.updateMany({
            where: { businessId, provider: 'BAILEYS' },
            data: { status: 'closed' }
          });
        }
        break;
        
      case 'qr.update':
        if (instanceId) {
          await prisma.whatsAppInstance.updateMany({
            where: { businessId, instanceBackendId: instanceId },
            data: { 
              status: 'pending_qr',
              qr: data?.qr
            }
          });
        } else {
          await prisma.whatsAppInstance.updateMany({
            where: { businessId, provider: 'BAILEYS' },
            data: { 
              status: 'pending_qr',
              qr: data?.qr
            }
          });
        }
        break;
        
      case 'message.received':
        // Normalize message type and content - handle all possible message formats
        // Location can come as: data.type='location', data.latitude, or nested data.locationMessage
        const hasLocationData = data?.latitude !== undefined || 
          data?.type === 'location' || 
          data?.type === 'live_location' ||
          data?.locationMessage || 
          data?.liveLocationMessage;
        
        // Product/order messages from catalog
        const hasProductData = data?.type === 'product' ||
          data?.productMessage ||
          data?.orderMessage ||
          (data?.availableTypes && (
            data.availableTypes.includes('productMessage') || 
            data.availableTypes.includes('orderMessage')
          ));
        
        const hasContent = data && (
          data.text || 
          data.mediaUrl || 
          hasLocationData || 
          hasProductData
        );
        
        if (hasContent) {
          const fromJid = data.from || '';
          if (fromJid.endsWith('@g.us') || fromJid.includes('@g.us')) {
            console.log(`Ignoring group message from ${fromJid}`);
            return res.json({ received: true, ignored: 'group_message' });
          }
          
          const providerMessageId = data.key?.id || data.messageId || data.id || null;
          
          // ATOMIC deduplication - prevents race conditions
          if (providerMessageId && await isBaileysMessageDuplicate(providerMessageId)) {
            return res.json({ received: true, ignored: 'duplicate_message' });
          }
          
          // Secondary check in DB (for messages that passed Redis check but already in DB)
          if (providerMessageId) {
            const existingMessage = await prisma.messageLog.findFirst({
              where: {
                businessId,
                providerMessageId
              }
            });
            
            if (existingMessage) {
              console.log(`[WEBHOOK] Duplicate message in DB, skipping: ${providerMessageId}`);
              return res.json({ received: true, ignored: 'duplicate_message_db' });
            }
          }
          
          const instance = await prisma.whatsAppInstance.findFirst({
            where: { businessId }
          });
          
          // Generate backendId dynamically if null (fallback for old data)
          const resolvedBackendId = instance?.instanceBackendId || `biz_${businessId.substring(0, 8)}`;
          console.log(`[WEBHOOK] Instance for business ${businessId}: id=${instance?.id}, backendId=${resolvedBackendId}, provider=${instance?.provider || 'BAILEYS'}`);
          
          // Extract phone number - handle both standard @s.whatsapp.net and LID @lid formats
          // Priority: phoneNumber (resolved) > sender cleaned > from cleaned
          let contactPhone = data.phoneNumber;
          const isLidMessage = data.isLid || data.sender?.endsWith('@lid') || data.from?.endsWith('@lid');
          const originalLid = isLidMessage ? (data.sender || data.from)?.replace(/@lid$/, '') : null;
          
          // If we have a resolved phoneNumber from the WhatsApp API, use it
          // Otherwise, only use sender/from if it's NOT a @lid (to avoid creating duplicate conversations)
          if (!contactPhone && data.sender && !data.sender.endsWith('@lid')) {
            contactPhone = data.sender.replace(/@s\.whatsapp\.net$/, '');
          }
          if (!contactPhone && data.from && !data.from.endsWith('@lid')) {
            contactPhone = data.from.replace(/@s\.whatsapp\.net$/, '');
          }
          // Final cleanup - ensure only digits
          contactPhone = contactPhone?.replace(/\D/g, '') || '';
          
          // Skip if we couldn't resolve a valid phone number (LID not mapped)
          // This prevents creating duplicate conversations for unresolved @lid messages
          if (!contactPhone || contactPhone.length < 8) {
            console.log(`[WEBHOOK] Skipping message - unresolved LID without phone mapping: sender=${data.sender}, from=${data.from}, lid=${originalLid}`);
            return res.json({ received: true, ignored: 'unresolved_lid', lid: originalLid });
          }
          
          // If this message resolved a LID to a phone number, update any pending messages with this LID
          if (isLidMessage && contactPhone && originalLid) {
            const updatedCount = await prisma.messageLog.updateMany({
              where: {
                businessId,
                metadata: { path: ['originalLid'], equals: originalLid }
              },
              data: {
                sender: contactPhone,
                metadata: { set: { lidResolved: true, resolvedPhone: contactPhone } }
              }
            });
            if (updatedCount.count > 0) {
              console.log(`[WEBHOOK] Resolved LID ${originalLid} -> ${contactPhone}, updated ${updatedCount.count} pending messages`);
            }
          }
          
          const contactJid = data.from;
          const isFromMe = data.isFromMe || false;
          const contactName = isFromMe ? '' : (data.pushName || '');
          
          let mediaAnalysis: string | null = null;
          const mediaType = data.type || '';
          
          if (!isFromMe && data.mediaUrl && ['audio', 'ptt', 'image', 'sticker', 'video'].includes(mediaType)) {
            mediaAnalysis = await processMediaWithGemini(
              data.mediaUrl, 
              mediaType, 
              businessId,
              business.userId
            );
            
            if (mediaType === 'image') {
              const pendingVoucherOrder = await prisma.order.findFirst({
                where: {
                  businessId,
                  contactPhone: contactPhone.replace(/\D/g, ''),
                  status: 'AWAITING_VOUCHER',
                  voucherImageUrl: null
                },
                orderBy: { createdAt: 'desc' },
                include: { items: true }
              });
              
              if (pendingVoucherOrder) {
                if (geminiService.isConfigured()) {
                  console.log(`[WEBHOOK] Validating potential voucher for order ${pendingVoucherOrder.id}`);
                  
                  const voucherValidation = await geminiService.validatePaymentVoucher(
                    data.mediaUrl,
                    {
                      amount: Number(pendingVoucherOrder.totalAmount),
                      currency: pendingVoucherOrder.currencyCode || 'PEN'
                    }
                  );
                  
                  if (voucherValidation.isPaymentProof && voucherValidation.isValid) {
                    await prisma.order.update({
                      where: { id: pendingVoucherOrder.id },
                      data: {
                        voucherImageUrl: data.mediaUrl,
                        voucherReceivedAt: new Date(),
                        notes: JSON.stringify({
                          voucherValidation: {
                            brand: voucherValidation.brand,
                            detectedAmount: voucherValidation.amount,
                            currency: voucherValidation.currency,
                            operationCode: voucherValidation.operationCode,
                            confidence: voucherValidation.confidence,
                            reason: voucherValidation.reason,
                            validatedAt: new Date().toISOString()
                          }
                        })
                      }
                    });
                    console.log(`[WEBHOOK] Valid voucher attached to order ${pendingVoucherOrder.id}: brand=${voucherValidation.brand}, amount=${voucherValidation.amount}, code=${voucherValidation.operationCode}`);
                    
                    // Add context for agent to confirm voucher received
                    mediaAnalysis = `[COMPROBANTE DE PAGO RECIBIDO Y VALIDADO] Se ha recibido un comprobante de pago válido para el pedido #${pendingVoucherOrder.id.slice(-6).toUpperCase()}. Banco/App: ${voucherValidation.brand || 'detectado'}, Monto: ${voucherValidation.currency || ''}${voucherValidation.amount || 'detectado'}. El equipo verificará el pago y procesará el pedido.`;
                    
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
                    console.log(`[WEBHOOK] Image rejected as voucher for order ${pendingVoucherOrder.id}: isPaymentProof=${voucherValidation.isPaymentProof}, isValid=${voucherValidation.isValid}, reason=${voucherValidation.reason}`);
                    
                    // Add context for agent to request a valid voucher
                    if (!voucherValidation.isPaymentProof) {
                      mediaAnalysis = `[IMAGEN RECIBIDA - NO ES COMPROBANTE DE PAGO] El cliente tiene un pedido pendiente #${pendingVoucherOrder.id.slice(-6).toUpperCase()} por ${pendingVoucherOrder.currencySymbol}${pendingVoucherOrder.totalAmount} esperando comprobante de pago. La imagen enviada NO es un comprobante de pago válido (${voucherValidation.reason || 'no se detecta transferencia bancaria o recibo'}). Debes pedirle amablemente que envíe el comprobante de su transferencia o pago.`;
                    } else {
                      mediaAnalysis = `[COMPROBANTE DE PAGO DUDOSO] El cliente envió lo que parece ser un comprobante de pago, pero no se pudo validar correctamente (${voucherValidation.reason || 'imagen poco clara o datos incompletos'}). Confianza: ${Math.round((voucherValidation.confidence || 0) * 100)}%. Pídele que envíe una imagen más clara del comprobante donde se vea el monto, banco y código de operación.`;
                    }
                  }
                } else {
                  await prisma.order.update({
                    where: { id: pendingVoucherOrder.id },
                    data: {
                      voucherImageUrl: data.mediaUrl,
                      voucherReceivedAt: new Date(),
                      notes: JSON.stringify({
                        voucherValidation: {
                          validated: false,
                          reason: 'Gemini not configured - manual verification required',
                          attachedAt: new Date().toISOString()
                        }
                      })
                    }
                  });
                  console.log(`[WEBHOOK] Voucher image attached to order ${pendingVoucherOrder.id} (Gemini not configured - no validation)`);
                }
              }
            }
          }
          
          // Build message text - include location info if present
          let messageText = data.text || null;
          
          // Normalize location data from various sources
          let latitude: number | undefined;
          let longitude: number | undefined;
          let isLocationMessage = false;
          
          if (data.type === 'location' || data.type === 'live_location') {
            isLocationMessage = true;
            latitude = data.latitude;
            longitude = data.longitude;
          } else if (data.locationMessage) {
            isLocationMessage = true;
            latitude = data.locationMessage.degreesLatitude;
            longitude = data.locationMessage.degreesLongitude;
          } else if (data.liveLocationMessage) {
            isLocationMessage = true;
            latitude = data.liveLocationMessage.degreesLatitude;
            longitude = data.liveLocationMessage.degreesLongitude;
          }
          
          // Normalize product data
          let isProductMessage = false;
          let productInfo: any = null;
          
          if (data.productMessage) {
            isProductMessage = true;
            productInfo = data.productMessage;
          } else if (data.orderMessage) {
            isProductMessage = true;
            productInfo = data.orderMessage;
          } else if (data.availableTypes?.includes('productMessage') || data.availableTypes?.includes('orderMessage')) {
            isProductMessage = true;
          }
          
          if (isLocationMessage && latitude !== undefined && longitude !== undefined) {
            messageText = `📍 Ubicación compartida: https://www.google.com/maps?q=${latitude},${longitude}`;
            if (!mediaAnalysis) {
              mediaAnalysis = `El cliente compartió su ubicación: latitud ${latitude}, longitud ${longitude}. Puedes usar estas coordenadas para el envío.`;
            }
          }
          
          if (isProductMessage) {
            const productTitle = productInfo?.product?.title || productInfo?.title || '';
            messageText = messageText || `🛒 El cliente envió un producto del catálogo${productTitle ? `: ${productTitle}` : ''}`;
            if (!mediaAnalysis) {
              mediaAnalysis = `El cliente seleccionó un producto del catálogo de WhatsApp Business${productTitle ? ` (${productTitle})` : ''}. Confirma el producto y procede con la venta.`;
            }
          }
          
          const messageLog = await prisma.messageLog.create({
            data: {
              businessId,
              instanceId: instance?.id,
              providerMessageId: providerMessageId || undefined,
              direction: isFromMe ? 'outbound' : 'inbound',
              sender: isFromMe ? undefined : contactPhone,
              recipient: isFromMe ? contactPhone : undefined,
              message: messageText,
              mediaUrl: data.mediaUrl || null,
              metadata: {
                ...data,
                contactPhone,
                contactName,
                contactJid,
                isFromMe,
                isLidMessage: isLidMessage || undefined,
                originalLid: originalLid || undefined,
                mediaAnalysis: mediaAnalysis || undefined,
                mediaType: mediaType || undefined,
                isLocationMessage: isLocationMessage || undefined,
                latitude: latitude,
                longitude: longitude,
                isProductMessage: isProductMessage || undefined,
                productInfo: productInfo || undefined,
                quotedMessage: data.quotedMessage || undefined,
                referredProduct: data.referredProduct || undefined
              }
            }
          });
          
          // Upsert Contact so conversation appears in frontend chat list
          if (!isFromMe && contactPhone) {
            try {
              const now = new Date();
              await prisma.contact.upsert({
                where: {
                  businessId_phone: { businessId, phone: contactPhone }
                },
                create: {
                  businessId,
                  phone: contactPhone,
                  name: contactName || null,
                  source: 'BAILEYS',
                  firstMessageAt: now,
                  lastMessageAt: now,
                  messageCount: 1
                },
                update: {
                  name: contactName || undefined,
                  lastMessageAt: now,
                  messageCount: { increment: 1 }
                }
              });
              console.log(`[WEBHOOK] Contact upserted: ${contactPhone} for business ${businessId}`);
            } catch (contactErr: any) {
              console.error(`[WEBHOOK] Failed to upsert contact ${contactPhone}:`, contactErr.message);
            }
          }
          
          // Dispatch user_message webhook for incoming messages
          if (!isFromMe) {
            console.log(`[WEBHOOK] Dispatching user_message webhook for business ${businessId}, contact ${contactPhone}, instance ${instance?.id}`);
            // Use messageText which already includes location/product info
            const dispatchMessage = mediaAnalysis ? `${messageText || ''}\n[Media: ${mediaAnalysis}]` : (messageText || '');
            dispatchUserMessage(
              businessId,
              contactPhone,
              contactName,
              dispatchMessage,
              isLocationMessage ? 'location' : (isProductMessage ? 'product' : (mediaType || 'text')),
              data.mediaUrl,
              {
                analysis: mediaAnalysis || undefined,
                efficoreMessageId: messageLog.id,
                baileysMessageId: providerMessageId,
                latitude: latitude,
                longitude: longitude
              },
              instance?.id
            ).catch(err => console.error('[WEBHOOK] Failed to dispatch user_message webhook:', err.message));
          }
          
          if (!isFromMe) {
            const cleanPhoneForSettings = contactPhone.replace(/\D/g, '').replace(/:.*$/, '');
            const contactSettings = await prisma.contactSettings.findFirst({
              where: {
                businessId,
                contactPhone: cleanPhoneForSettings
              }
            });
            
            // Check if contact has testing mode enabled (from Contact table)
            const contact = await prisma.contact.findFirst({
              where: {
                businessId,
                phone: cleanPhoneForSettings
              },
              select: { botTestEnabled: true }
            });
            
            // Determine if we should process this message with the agent
            let shouldProcessWithAgent = false;
            
            if (business.botEnabled) {
              // Bot is globally enabled - process unless disabled for this contact
              if (contactSettings?.botDisabled) {
                console.log(`[WEBHOOK] Bot disabled for contact ${cleanPhoneForSettings}, skipping agent`);
              } else {
                shouldProcessWithAgent = true;
              }
            } else if (contact?.botTestEnabled) {
              // Bot is globally disabled BUT testing mode is enabled for this contact
              console.log(`[WEBHOOK] Bot globally disabled but Testing ON for contact ${cleanPhoneForSettings}, processing with agent`);
              shouldProcessWithAgent = true;
            } else {
              console.log(`[WEBHOOK] Bot globally disabled and no testing mode for contact ${cleanPhoneForSettings}, skipping agent`);
            }
            
            if (shouldProcessWithAgent) {
            let messageForAgent = data.text || '';
            
            if (mediaAnalysis) {
              const mediaLabels: Record<string, string> = {
                'audio': '[Nota de voz]',
                'ptt': '[Nota de voz]',
                'image': '[Imagen]',
                'sticker': '[Sticker]',
                'video': '[Video]'
              };
              const label = mediaLabels[mediaType] || '[Media]';
              
              if (messageForAgent) {
                messageForAgent = `${messageForAgent}\n\n${label}: ${mediaAnalysis}`;
              } else {
                messageForAgent = `${label}: ${mediaAnalysis}`;
              }
            }
            
            // Extract quoted message context if present
            let quotedContext = '';
            if (data.quotedMessage) {
              const qm = data.quotedMessage;
              const quotedText = qm.text || qm.caption || '';
              const quotedType = qm.type || 'mensaje';
              if (quotedText) {
                quotedContext = `\n\n[SISTEMA - El cliente está respondiendo a un ${quotedType} anterior: "${quotedText.substring(0, 200)}${quotedText.length > 200 ? '...' : ''}"]`;
              } else if (quotedType !== 'text') {
                quotedContext = `\n\n[SISTEMA - El cliente está respondiendo a un ${quotedType} anterior]`;
              }
              console.log(`[WEBHOOK] Quoted message context detected:`, { quotedType, quotedTextLength: quotedText?.length || 0 });
            }
            
            // Extract referred product context if present
            let productContext = '';
            if (data.referredProduct) {
              const product = data.referredProduct;
              const productName = product.title || product.productId || 'producto del catálogo';
              const productPrice = product.price ? ` - Precio: ${product.currency || ''} ${product.price}` : '';
              productContext = `\n\n[SISTEMA - El cliente está consultando sobre un producto del catálogo de WhatsApp: "${productName}"${productPrice}]`;
              console.log(`[WEBHOOK] Product reference detected:`, { productId: product.productId, title: product.title });
            }
            
            // Append context to message
            if (quotedContext || productContext) {
              messageForAgent = messageForAgent + quotedContext + productContext;
            }
            
            if (messageForAgent) {
              try {
                console.log(`[WEBHOOK] Calling agent/think with backendId: ${resolvedBackendId}`);
                await axios.post(`${CORE_API_URL}/agent/think`, {
                  business_id: businessId,
                  user_message: messageForAgent,
                  phone: contactJid,
                  phoneNumber: contactPhone,
                  contactName,
                  instanceId: instance?.id,
                  instanceBackendId: resolvedBackendId,
                  quotedMessage: data.quotedMessage || undefined,
                  referredProduct: data.referredProduct || undefined
                }, {
                  headers: { 'X-Internal-Secret': INTERNAL_AGENT_SECRET }
                });
              } catch (err: any) {
                console.error('Agent think failed:', err.response?.data || err.message);
              }
            }
            }
          }

          if (!isFromMe) {
            setImmediate(async () => {
              try {
                // Normalize phone to digits only for consistent tag assignment
                const normalizedPhone = contactPhone.replace(/\D/g, '').replace(/:.*$/, '');
                const instanceId = instance?.id;
                console.log(`[WEBHOOK] Processing data extraction for normalized phone: ${normalizedPhone} (original: ${contactPhone}), instanceId: ${instanceId || 'none'}`);
                // NOTE: Automatic tag updates by IA are disabled - tags are now manual-only
                // await analyzeAndUpdateLeadStage(businessId, normalizedPhone);
                
                // Use processDataExtraction which triggers auto-order creation
                await processDataExtraction(businessId, normalizedPhone, instanceId);
                
                // Check if contact can advance to next funnel stage (also triggers auto-order)
                await checkAndAdvanceStage(businessId, normalizedPhone, instanceId);
              } catch (err: any) {
                console.error('Lead stage/data extraction failed:', err.message);
              }
            });
          }
        }
        break;
        
      case 'message.sent':
        break;
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;

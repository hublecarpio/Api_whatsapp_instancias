import { Router, Request, Response } from 'express';
import axios from 'axios';
import prisma from '../services/prisma.js';
import { analyzeAndUpdateLeadStage, extractAndSaveContactData } from '../services/leadStageService.js';
import { geminiService } from '../services/gemini.js';
import { logTokenUsage } from '../services/tokenLogger.js';
import { dispatchUserMessage } from '../services/webhookService.js';

const router = Router();
const CORE_API_URL = process.env.CORE_API_URL || 'http://localhost:3001';
const INTERNAL_AGENT_SECRET = process.env.INTERNAL_AGENT_SECRET || 'internal-agent-secret-change-me';

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
        if (data && (data.text || data.mediaUrl)) {
          const fromJid = data.from || '';
          if (fromJid.endsWith('@g.us') || fromJid.includes('@g.us')) {
            console.log(`Ignoring group message from ${fromJid}`);
            return res.json({ received: true, ignored: 'group_message' });
          }
          
          const providerMessageId = data.key?.id || data.messageId || data.id || null;
          
          if (providerMessageId) {
            const existingMessage = await prisma.messageLog.findFirst({
              where: {
                businessId,
                providerMessageId
              }
            });
            
            if (existingMessage) {
              console.log(`[WEBHOOK] Duplicate message detected, skipping: ${providerMessageId}`);
              return res.json({ received: true, ignored: 'duplicate_message' });
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
          
          await prisma.messageLog.create({
            data: {
              businessId,
              instanceId: instance?.id,
              providerMessageId: providerMessageId || undefined,
              direction: isFromMe ? 'outbound' : 'inbound',
              sender: isFromMe ? undefined : contactPhone,
              recipient: isFromMe ? contactPhone : undefined,
              message: data.text || null,
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
                mediaType: mediaType || undefined
              }
            }
          });
          
          // Dispatch user_message webhook for incoming messages
          if (!isFromMe) {
            console.log(`[WEBHOOK] Dispatching user_message webhook for business ${businessId}, contact ${contactPhone}`);
            dispatchUserMessage(
              businessId,
              contactPhone,
              contactName,
              mediaAnalysis ? `${data.text || ''}\n[Media: ${mediaAnalysis}]` : (data.text || ''),
              mediaType || 'text',
              data.mediaUrl,
              mediaAnalysis ? { analysis: mediaAnalysis } : undefined
            ).catch(err => console.error('[WEBHOOK] Failed to dispatch user_message webhook:', err.message));
          }
          
          if (!isFromMe && business.botEnabled) {
            const cleanPhoneForSettings = contactPhone.replace(/\D/g, '').replace(/:.*$/, '');
            const contactSettings = await prisma.contactSettings.findFirst({
              where: {
                businessId,
                contactPhone: cleanPhoneForSettings
              }
            });
            
            if (contactSettings?.botDisabled) {
              console.log(`Bot disabled for contact ${cleanPhoneForSettings}, skipping agent`);
            } else {
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
                  instanceBackendId: resolvedBackendId
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
                console.log(`[WEBHOOK] Lead stage analysis for normalized phone: ${normalizedPhone} (original: ${contactPhone})`);
                await analyzeAndUpdateLeadStage(businessId, normalizedPhone);
                await extractAndSaveContactData(businessId, normalizedPhone);
              } catch (err: any) {
                console.error('Lead stage analysis failed:', err.message);
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

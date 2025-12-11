import { Router, Request, Response } from 'express';
import axios from 'axios';
import prisma from '../services/prisma.js';
import { analyzeAndUpdateLeadStage, extractAndSaveContactData } from '../services/leadStageService.js';
import { geminiService } from '../services/gemini.js';
import { logTokenUsage } from '../services/tokenLogger.js';

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
        await prisma.whatsAppInstance.updateMany({
          where: { businessId },
          data: { 
            status: 'open',
            lastConnection: new Date(),
            phoneNumber: data?.phoneNumber
          }
        });
        break;
        
      case 'connection.close':
        await prisma.whatsAppInstance.updateMany({
          where: { businessId },
          data: { status: 'closed' }
        });
        break;
        
      case 'qr.update':
        await prisma.whatsAppInstance.updateMany({
          where: { businessId },
          data: { 
            status: 'pending_qr',
            qr: data?.qr
          }
        });
        break;
        
      case 'message.received':
        if (data && (data.text || data.mediaUrl)) {
          const fromJid = data.from || '';
          if (fromJid.endsWith('@g.us') || fromJid.includes('@g.us')) {
            console.log(`Ignoring group message from ${fromJid}`);
            return res.json({ received: true, ignored: 'group_message' });
          }
          
          const instance = await prisma.whatsAppInstance.findFirst({
            where: { businessId }
          });
          
          const contactPhone = data.phoneNumber || data.sender?.replace('@s.whatsapp.net', '') || data.from;
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
          }
          
          await prisma.messageLog.create({
            data: {
              businessId,
              instanceId: instance?.id,
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
                mediaAnalysis: mediaAnalysis || undefined,
                mediaType: mediaType || undefined
              }
            }
          });
          
          if (!isFromMe && business.botEnabled) {
            const cleanPhoneForSettings = contactPhone.replace(/\D/g, '').replace(/:.*$/, '');
            const contactSettings = await prisma.contactSettings.findUnique({
              where: {
                businessId_contactPhone: {
                  businessId,
                  contactPhone: cleanPhoneForSettings
                }
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
                await axios.post(`${CORE_API_URL}/agent/think`, {
                  business_id: businessId,
                  user_message: messageForAgent,
                  phone: contactJid,
                  phoneNumber: contactPhone,
                  contactName,
                  instanceId: instance?.id,
                  instanceBackendId: instance?.instanceBackendId
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
                await analyzeAndUpdateLeadStage(businessId, contactPhone);
                await extractAndSaveContactData(businessId, contactPhone);
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

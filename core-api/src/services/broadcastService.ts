import prisma from './prisma';
import { MetaCloudService } from './metaCloud';
import axios from 'axios';

type BroadcastMessageType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'TEMPLATE';
type BroadcastLogStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

interface BroadcastResult {
  success: boolean;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRandomDelay(minSeconds: number, maxSeconds: number): number {
  const minMs = minSeconds * 1000;
  const maxMs = maxSeconds * 1000;
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function interpolateVariables(text: string | null, variables: string[]): string | null {
  if (!text) return text;
  let result = text;
  for (let i = 0; i < variables.length; i++) {
    const placeholder = `{{${i + 1}}}`;
    result = result.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), variables[i] || '');
  }
  return result;
}

function interpolateNamedVariables(text: string | null, namedVars: Record<string, string | null>): string | null {
  if (!text) return text;
  let result = text;
  for (const [key, value] of Object.entries(namedVars)) {
    const placeholder = `{{${key}}}`;
    result = result.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value || '');
  }
  return result;
}

export async function isWithin24HourWindow(businessId: string, contactPhone: string): Promise<boolean> {
  const cleanPhone = contactPhone.replace(/\D/g, '');
  
  const lastInboundMessage = await prisma.messageLog.findFirst({
    where: {
      businessId,
      direction: 'inbound',
      sender: cleanPhone
    },
    orderBy: { createdAt: 'desc' }
  });

  if (!lastInboundMessage) return false;

  const timeDiff = Date.now() - lastInboundMessage.createdAt.getTime();
  return timeDiff < TWENTY_FOUR_HOURS_MS;
}

export async function sendBroadcastMessage(
  campaignId: string,
  logId: string,
  contactPhone: string,
  contactName: string | null,
  variables: string[],
  campaign: {
    businessId: string;
    messageType: BroadcastMessageType;
    content: string | null;
    mediaUrl: string | null;
    mediaCaption: string | null;
    fileName: string | null;
    templateId: string | null;
    templateParams: any;
  },
  namedVariables?: Record<string, string | null>
): Promise<{ success: boolean; usedTemplate: boolean; error?: string }> {
  const cleanPhone = contactPhone.replace(/\D/g, '');

  let interpolatedContent = interpolateVariables(campaign.content, variables);
  let interpolatedCaption = interpolateVariables(campaign.mediaCaption, variables);
  
  if (namedVariables && Object.keys(namedVariables).length > 0) {
    interpolatedContent = interpolateNamedVariables(interpolatedContent, namedVariables);
    interpolatedCaption = interpolateNamedVariables(interpolatedCaption, namedVariables);
  }
  
  const interpolatedCampaign = {
    ...campaign,
    content: interpolatedContent,
    mediaCaption: interpolatedCaption
  };

  try {
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { businessId: campaign.businessId },
      include: { metaCredential: true }
    });

    if (!instance) {
      return { success: false, usedTemplate: false, error: 'No WhatsApp instance found' };
    }

    const isMetaCloud = instance.provider === 'META_CLOUD';
    let usedTemplate = false;

    if (isMetaCloud) {
      if (!instance.metaCredential) {
        return { success: false, usedTemplate: false, error: 'Meta credentials not found' };
      }

      const metaService = new MetaCloudService({
        accessToken: instance.metaCredential.accessToken,
        phoneNumberId: instance.metaCredential.phoneNumberId,
        businessId: instance.metaCredential.businessId
      });

      const within24h = await isWithin24HourWindow(campaign.businessId, cleanPhone);

      if (!within24h && campaign.templateId) {
        usedTemplate = true;
        const template = await prisma.metaTemplate.findUnique({
          where: { id: campaign.templateId }
        });

        if (!template) {
          return { success: false, usedTemplate: true, error: 'Template not found' };
        }

        let templateComponents = campaign.templateParams || [];
        if (variables.length > 0) {
          const bodyComponent = { type: 'body', parameters: variables.map(v => ({ type: 'text', text: v })) };
          const hasBody = templateComponents.some((c: any) => c.type === 'body');
          if (hasBody) {
            templateComponents = templateComponents.map((c: any) => 
              c.type === 'body' ? bodyComponent : c
            );
          } else {
            templateComponents = [...templateComponents, bodyComponent];
          }
        }

        await metaService.sendTemplate({
          to: cleanPhone,
          templateName: template.name,
          language: template.language,
          components: templateComponents
        });
      } else if (!within24h && !campaign.templateId) {
        return { success: false, usedTemplate: false, error: 'Outside 24h window and no template configured' };
      } else {
        await sendMetaCloudMessage(metaService, cleanPhone, interpolatedCampaign);
      }
    } else {
      await sendBaileysMessage(instance.instanceBackendId!, cleanPhone, interpolatedCampaign);
    }

    await prisma.broadcastLog.update({
      where: { id: logId },
      data: {
        status: 'SENT',
        usedTemplate,
        sentAt: new Date()
      }
    });

    return { success: true, usedTemplate };
  } catch (error: any) {
    const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown error';
    
    await prisma.broadcastLog.update({
      where: { id: logId },
      data: {
        status: 'FAILED',
        error: errorMessage
      }
    });

    return { success: false, usedTemplate: false, error: errorMessage };
  }
}

async function sendMetaCloudMessage(
  metaService: MetaCloudService,
  phone: string,
  campaign: {
    messageType: BroadcastMessageType;
    content: string | null;
    mediaUrl: string | null;
    mediaCaption: string | null;
    fileName: string | null;
  }
): Promise<void> {
  switch (campaign.messageType) {
    case 'TEXT':
      if (campaign.content) {
        await metaService.sendTextMessage(phone, campaign.content);
      }
      break;
    case 'IMAGE':
      if (campaign.mediaUrl) {
        await metaService.sendImageMessage(phone, campaign.mediaUrl, campaign.mediaCaption || undefined);
      }
      break;
    case 'VIDEO':
      if (campaign.mediaUrl) {
        await metaService.sendVideoMessage(phone, campaign.mediaUrl, campaign.mediaCaption || undefined);
      }
      break;
    case 'AUDIO':
      if (campaign.mediaUrl) {
        await metaService.sendAudioMessage(phone, campaign.mediaUrl);
      }
      break;
    case 'DOCUMENT':
      if (campaign.mediaUrl) {
        await metaService.sendDocumentMessage(phone, campaign.mediaUrl, campaign.fileName || undefined, campaign.mediaCaption || undefined);
      }
      break;
  }
}

async function sendBaileysMessage(
  instanceBackendId: string,
  phone: string,
  campaign: {
    messageType: BroadcastMessageType;
    content: string | null;
    mediaUrl: string | null;
    mediaCaption: string | null;
    fileName: string | null;
  }
): Promise<void> {
  const recipient = `${phone}@s.whatsapp.net`;

  switch (campaign.messageType) {
    case 'TEXT':
      if (campaign.content) {
        await axios.post(`${WA_API_URL}/instances/${instanceBackendId}/sendMessage`, {
          to: recipient,
          message: campaign.content
        });
      }
      break;
    case 'IMAGE':
      if (campaign.mediaUrl) {
        await axios.post(`${WA_API_URL}/instances/${instanceBackendId}/sendImage`, {
          to: recipient,
          url: campaign.mediaUrl,
          caption: campaign.mediaCaption || ''
        });
      }
      break;
    case 'VIDEO':
      if (campaign.mediaUrl) {
        await axios.post(`${WA_API_URL}/instances/${instanceBackendId}/sendVideo`, {
          to: recipient,
          url: campaign.mediaUrl,
          caption: campaign.mediaCaption || ''
        });
      }
      break;
    case 'AUDIO':
      if (campaign.mediaUrl) {
        await axios.post(`${WA_API_URL}/instances/${instanceBackendId}/sendAudio`, {
          to: recipient,
          url: campaign.mediaUrl,
          ptt: true
        });
      }
      break;
    case 'DOCUMENT':
      if (campaign.mediaUrl) {
        await axios.post(`${WA_API_URL}/instances/${instanceBackendId}/sendFile`, {
          to: recipient,
          url: campaign.mediaUrl,
          fileName: campaign.fileName || 'document',
          mimeType: 'application/octet-stream'
        });
      }
      break;
  }
}

export async function runBroadcastCampaign(campaignId: string): Promise<BroadcastResult> {
  const campaign = await prisma.broadcastCampaign.findUnique({
    where: { id: campaignId },
    include: { logs: { where: { status: 'PENDING' } } }
  });

  if (!campaign) {
    throw new Error('Campaign not found');
  }

  if (campaign.status === 'CANCELLED' || campaign.status === 'COMPLETED') {
    throw new Error('Campaign is already cancelled or completed');
  }

  await prisma.broadcastCampaign.update({
    where: { id: campaignId },
    data: { status: 'RUNNING', startedAt: new Date() }
  });

  let sentCount = campaign.sentCount;
  let failedCount = campaign.failedCount;
  let skippedCount = 0;

  for (const log of campaign.logs) {
    const refreshedCampaign = await prisma.broadcastCampaign.findUnique({
      where: { id: campaignId }
    });

    if (refreshedCampaign?.status === 'PAUSED' || refreshedCampaign?.status === 'CANCELLED') {
      console.log(`[BROADCAST] Campaign ${campaignId} was paused/cancelled, stopping...`);
      break;
    }

    await prisma.broadcastLog.update({
      where: { id: log.id },
      data: { status: 'SENDING' }
    });

    const logMetadata = log.metadata as { variables?: string[]; namedVariables?: Record<string, string | null> } | null;
    const variables = logMetadata?.variables || [];
    const namedVariables = logMetadata?.namedVariables || {};

    const result = await sendBroadcastMessage(
      campaignId,
      log.id,
      log.contactPhone,
      log.contactName,
      variables,
      campaign,
      namedVariables
    );

    if (result.success) {
      sentCount++;
    } else {
      if (result.error?.includes('Outside 24h window')) {
        skippedCount++;
        await prisma.broadcastLog.update({
          where: { id: log.id },
          data: { status: 'SKIPPED', error: result.error }
        });
      } else {
        failedCount++;
      }
    }

    await prisma.broadcastCampaign.update({
      where: { id: campaignId },
      data: { sentCount, failedCount }
    });

    const delay = getRandomDelay(campaign.delayMinSeconds, campaign.delayMaxSeconds);
    console.log(`[BROADCAST] Waiting ${delay}ms before next message...`);
    await sleep(delay);
  }

  const finalStatus = skippedCount + sentCount + failedCount >= campaign.totalContacts 
    ? 'COMPLETED' 
    : 'PAUSED';

  await prisma.broadcastCampaign.update({
    where: { id: campaignId },
    data: {
      status: finalStatus,
      completedAt: finalStatus === 'COMPLETED' ? new Date() : undefined
    }
  });

  return { success: true, sentCount, failedCount, skippedCount };
}

interface ContactWithVariables {
  phone: string;
  variables: string[];
}

export async function createBroadcastCampaign(params: {
  businessId: string;
  name: string;
  messageType: BroadcastMessageType;
  content?: string;
  mediaUrl?: string;
  mediaCaption?: string;
  fileName?: string;
  templateId?: string;
  templateParams?: any;
  contactsWithVariables: ContactWithVariables[];
  delayMinSeconds?: number;
  delayMaxSeconds?: number;
  createdBy?: string;
  useCrmMetadata?: boolean;
}): Promise<{ campaignId: string; totalContacts: number }> {
  const phoneToVars: Record<string, string[]> = {};
  const allPhones: string[] = [];
  const seenPhones = new Set<string>();
  
  for (const c of params.contactsWithVariables) {
    const normalizedPhone = c.phone.replace(/\D/g, '');
    if (normalizedPhone.length < 10 || seenPhones.has(normalizedPhone)) {
      continue;
    }
    seenPhones.add(normalizedPhone);
    phoneToVars[normalizedPhone] = c.variables;
    allPhones.push(normalizedPhone);
  }
  
  if (allPhones.length === 0) {
    throw new Error('No valid phone numbers provided');
  }

  const existingContacts = await prisma.contact.findMany({
    where: {
      businessId: params.businessId,
      phone: { in: allPhones }
    }
  });
  
  const existingPhones = new Set(existingContacts.map(c => c.phone));
  
  const now = new Date();
  const newContactsData = allPhones
    .filter(phone => !existingPhones.has(phone))
    .map(phone => ({
      businessId: params.businessId,
      phone,
      name: phoneToVars[phone]?.[0] || null,
      firstMessageAt: now,
      lastMessageAt: now
    }));
  
  if (newContactsData.length > 0) {
    await prisma.contact.createMany({ data: newContactsData, skipDuplicates: true });
  }

  const allContacts = await prisma.contact.findMany({
    where: {
      businessId: params.businessId,
      phone: { in: allPhones }
    }
  });

  let phoneToNamedVars: Record<string, Record<string, string | null>> = {};
  
  if (params.useCrmMetadata) {
    const extractedData = await prisma.contactExtractedData.findMany({
      where: {
        businessId: params.businessId,
        contactPhone: { in: allPhones }
      }
    });
    
    for (const contact of allContacts) {
      const contactExtracted = extractedData.filter((e: any) => e.contactPhone === contact.phone);
      phoneToNamedVars[contact.phone] = {
        nombre: contact.name,
        email: contact.email,
        telefono: contact.phone,
        ...contactExtracted.reduce((acc: any, e: any) => {
          acc[e.fieldKey] = e.fieldValue;
          return acc;
        }, {} as Record<string, string | null>)
      };
    }
    
    const textToCheck = [params.content, params.mediaCaption].filter(Boolean).join(' ');
    const variableRegex = /\{\{(\w+)\}\}/g;
    const requiredVariables: string[] = [];
    let match;
    while ((match = variableRegex.exec(textToCheck)) !== null) {
      if (!requiredVariables.includes(match[1])) requiredVariables.push(match[1]);
    }
    
    if (requiredVariables.length > 0) {
      const contactsMissingVars: string[] = [];
      for (const contact of allContacts) {
        const namedVars = phoneToNamedVars[contact.phone] || {};
        for (const varName of requiredVariables) {
          if (!namedVars[varName]) {
            contactsMissingVars.push(contact.phone);
            break;
          }
        }
      }
      
      if (contactsMissingVars.length > 0) {
        throw new Error(`${contactsMissingVars.length} contacto(s) no tienen los datos requeridos: ${requiredVariables.join(', ')}. Elimina estos contactos o usa solo variables que todos tengan.`);
      }
    }
  }

  const campaign = await prisma.broadcastCampaign.create({
    data: {
      businessId: params.businessId,
      name: params.name,
      status: 'DRAFT',
      messageType: params.messageType,
      content: params.content,
      mediaUrl: params.mediaUrl,
      mediaCaption: params.mediaCaption,
      fileName: params.fileName,
      templateId: params.templateId,
      templateParams: params.templateParams,
      contactIds: allContacts.map(c => c.id),
      delayMinSeconds: params.delayMinSeconds || 3,
      delayMaxSeconds: params.delayMaxSeconds || 10,
      totalContacts: allContacts.length,
      createdBy: params.createdBy
    }
  });

  const logs = allContacts.map(contact => ({
    campaignId: campaign.id,
    contactPhone: contact.phone,
    contactName: contact.name,
    status: 'PENDING' as BroadcastLogStatus,
    metadata: { 
      variables: phoneToVars[contact.phone] || [],
      namedVariables: phoneToNamedVars[contact.phone] || {}
    }
  }));

  await prisma.broadcastLog.createMany({ data: logs });

  return { campaignId: campaign.id, totalContacts: allContacts.length };
}

export async function pauseBroadcastCampaign(campaignId: string): Promise<void> {
  await prisma.broadcastCampaign.update({
    where: { id: campaignId },
    data: { status: 'PAUSED' }
  });
}

export async function resumeBroadcastCampaign(campaignId: string): Promise<void> {
  runBroadcastCampaign(campaignId).catch(err => {
    console.error(`[BROADCAST] Error resuming campaign ${campaignId}:`, err);
  });
}

export async function cancelBroadcastCampaign(campaignId: string): Promise<void> {
  await prisma.broadcastCampaign.update({
    where: { id: campaignId },
    data: { status: 'CANCELLED' }
  });

  await prisma.broadcastLog.updateMany({
    where: { campaignId, status: 'PENDING' },
    data: { status: 'SKIPPED', error: 'Campaign cancelled' }
  });
}

export async function getCampaignStats(campaignId: string) {
  const campaign = await prisma.broadcastCampaign.findUnique({
    where: { id: campaignId }
  });

  if (!campaign) return null;

  const logs = await prisma.broadcastLog.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: true
  });

  const statusCounts = logs.reduce((acc, l) => {
    acc[l.status] = l._count;
    return acc;
  }, {} as Record<string, number>);

  return {
    ...campaign,
    pending: statusCounts['PENDING'] || 0,
    sending: statusCounts['SENDING'] || 0,
    sent: statusCounts['SENT'] || 0,
    failed: statusCounts['FAILED'] || 0,
    skipped: statusCounts['SKIPPED'] || 0,
    progress: campaign.totalContacts > 0 
      ? Math.round(((campaign.sentCount + campaign.failedCount) / campaign.totalContacts) * 100)
      : 0
  };
}

export async function getCampaignLogs(
  campaignId: string,
  status?: BroadcastLogStatus,
  limit = 50,
  offset = 0
) {
  const where: any = { campaignId };
  if (status) where.status = status;

  const [logs, total] = await Promise.all([
    prisma.broadcastLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset
    }),
    prisma.broadcastLog.count({ where })
  ]);

  return { logs, total };
}

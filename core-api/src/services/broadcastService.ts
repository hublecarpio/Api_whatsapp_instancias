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
  campaign: {
    businessId: string;
    messageType: BroadcastMessageType;
    content: string | null;
    mediaUrl: string | null;
    mediaCaption: string | null;
    fileName: string | null;
    templateId: string | null;
    templateParams: any;
  }
): Promise<{ success: boolean; usedTemplate: boolean; error?: string }> {
  const cleanPhone = contactPhone.replace(/\D/g, '');

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

        await metaService.sendTemplate({
          to: cleanPhone,
          templateName: template.name,
          language: template.language,
          components: campaign.templateParams || []
        });
      } else if (!within24h && !campaign.templateId) {
        return { success: false, usedTemplate: false, error: 'Outside 24h window and no template configured' };
      } else {
        await sendMetaCloudMessage(metaService, cleanPhone, campaign);
      }
    } else {
      await sendBaileysMessage(instance.instanceBackendId!, cleanPhone, campaign);
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

    const result = await sendBroadcastMessage(
      campaignId,
      log.id,
      log.contactPhone,
      log.contactName,
      campaign
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
  contactPhones: string[];
  delayMinSeconds?: number;
  delayMaxSeconds?: number;
  createdBy?: string;
}): Promise<{ campaignId: string; totalContacts: number }> {
  const contacts = await prisma.contact.findMany({
    where: {
      businessId: params.businessId,
      phone: { in: params.contactPhones.map(p => p.replace(/\D/g, '')) }
    }
  });

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
      contactIds: contacts.map(c => c.id),
      delayMinSeconds: params.delayMinSeconds || 3,
      delayMaxSeconds: params.delayMaxSeconds || 10,
      totalContacts: contacts.length,
      createdBy: params.createdBy
    }
  });

  const logs = contacts.map(contact => ({
    campaignId: campaign.id,
    contactPhone: contact.phone,
    contactName: contact.name,
    status: 'PENDING' as BroadcastLogStatus
  }));

  await prisma.broadcastLog.createMany({ data: logs });

  return { campaignId: campaign.id, totalContacts: contacts.length };
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

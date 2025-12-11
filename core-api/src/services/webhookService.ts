import axios from 'axios';
import crypto from 'crypto';
import prisma from './prisma.js';

interface WebhookPayload {
  event: string;
  timestamp: string;
  businessId: string;
  data: Record<string, any>;
}

function generateSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export async function dispatchWebhook(
  businessId: string,
  event: string,
  data: Record<string, any>
): Promise<void> {
  try {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        webhookUrl: true,
        webhookEvents: true,
        webhookSecret: true,
        agentVersion: true
      }
    });

    if (!business || !business.webhookUrl || business.agentVersion !== 'v2') {
      return;
    }

    if (!business.webhookEvents.includes(event)) {
      return;
    }

    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      businessId,
      data
    };

    const payloadString = JSON.stringify(payload);
    const signature = generateSignature(payloadString, business.webhookSecret || '');

    await axios.post(business.webhookUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': event
      },
      timeout: 5000
    });

    console.log(`[Webhook] Dispatched ${event} to ${business.webhookUrl}`);
  } catch (error: any) {
    console.error(`[Webhook] Failed to dispatch ${event}:`, error.message);
  }
}

export async function dispatchUserMessage(
  businessId: string,
  contactPhone: string,
  contactName: string,
  message: string,
  messageType: string = 'text',
  mediaUrl?: string,
  mediaDetails?: Record<string, any>
): Promise<void> {
  await dispatchWebhook(businessId, 'user_message', {
    contactPhone,
    contactName,
    message,
    messageType,
    mediaUrl,
    mediaDetails
  });
}

export async function dispatchAgentMessage(
  businessId: string,
  contactPhone: string,
  response: string,
  mediaUrls?: string[],
  toolsUsed?: string[]
): Promise<void> {
  await dispatchWebhook(businessId, 'agent_message', {
    contactPhone,
    response,
    mediaUrls,
    toolsUsed
  });
}

export async function dispatchStateChange(
  businessId: string,
  contactPhone: string,
  changeType: 'stage' | 'tag' | 'data',
  oldValue: any,
  newValue: any
): Promise<void> {
  await dispatchWebhook(businessId, 'state_change', {
    contactPhone,
    changeType,
    oldValue,
    newValue
  });
}

export async function dispatchToolCall(
  businessId: string,
  contactPhone: string,
  toolName: string,
  input: Record<string, any>,
  output: Record<string, any>,
  success: boolean
): Promise<void> {
  await dispatchWebhook(businessId, 'tool_call', {
    contactPhone,
    toolName,
    input,
    output,
    success
  });
}

export async function dispatchStageChange(
  businessId: string,
  contactPhone: string,
  oldStage: string | null,
  newStage: string
): Promise<void> {
  await dispatchWebhook(businessId, 'stage_change', {
    contactPhone,
    oldStage,
    newStage
  });
}

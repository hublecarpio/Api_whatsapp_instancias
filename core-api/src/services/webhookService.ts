import axios from 'axios';
import crypto from 'crypto';
import prisma from './prisma.js';

interface WebhookPayload {
  event: string;
  timestamp: string;
  businessId: string;
  data: Record<string, any>;
}

const DEFAULT_WEBHOOK_EVENTS = ['user_message', 'agent_message', 'stage_change', 'state_change', 'tool_call'];

function generateSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function sendWithRetry(
  url: string,
  payload: WebhookPayload,
  headers: Record<string, string>,
  maxRetries: number = 3
): Promise<boolean> {
  const delays = [0, 2000, 5000, 10000];
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        console.log(`[Webhook] Retry attempt ${attempt} for ${payload.event}`);
      }
      
      await axios.post(url, payload, {
        headers,
        timeout: 10000
      });
      
      return true;
    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries;
      const statusCode = error.response?.status;
      
      if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
        console.error(`[Webhook] Client error ${statusCode}, not retrying: ${error.message}`);
        return false;
      }
      
      if (isLastAttempt) {
        console.error(`[Webhook] All ${maxRetries + 1} attempts failed for ${payload.event}: ${error.message}`);
        return false;
      }
      
      console.warn(`[Webhook] Attempt ${attempt + 1} failed: ${error.message}`);
    }
  }
  
  return false;
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
        userId: true
      }
    });

    if (!business || !business.webhookUrl) {
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: business.userId },
      select: { subscriptionTier: true }
    });

    if (!user || (user.subscriptionTier !== 'PRO' && user.subscriptionTier !== 'ENTERPRISE')) {
      return;
    }

    const allowedEvents = business.webhookEvents.length > 0 
      ? business.webhookEvents 
      : DEFAULT_WEBHOOK_EVENTS;
    
    if (!allowedEvents.includes(event)) {
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

    const headers = {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': signature,
      'X-Webhook-Event': event
    };

    const success = await sendWithRetry(business.webhookUrl, payload, headers, 3);
    
    if (success) {
      console.log(`[Webhook] Successfully dispatched ${event} to ${business.webhookUrl}`);
    } else {
      console.error(`[Webhook] Failed to deliver ${event} to ${business.webhookUrl} after all retries`);
    }
  } catch (error: any) {
    console.error(`[Webhook] Critical error dispatching ${event}:`, error.message);
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

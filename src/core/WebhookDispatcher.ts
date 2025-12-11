import axios, { AxiosError } from 'axios';
import logger from '../utils/logger';
import { WebhookPayload } from '../utils/types';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF = 1000;

// In-memory deduplication for message events (prevents duplicate webhook calls)
const processedMessages = new Map<string, number>();
const MESSAGE_DEDUP_TTL_MS = 60000; // 1 minute TTL

// Cleanup old entries every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of processedMessages.entries()) {
    if (now - timestamp > MESSAGE_DEDUP_TTL_MS) {
      processedMessages.delete(key);
    }
  }
}, 30000);

export class WebhookDispatcher {
  private static async sendWithRetry(
    url: string,
    payload: WebhookPayload,
    retries: number = 0
  ): Promise<boolean> {
    try {
      await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      
      logger.info({ 
        instanceId: payload.instanceId, 
        event: payload.event,
        webhook: url 
      }, 'Webhook delivered successfully');
      
      return true;
    } catch (error) {
      const axiosError = error as AxiosError;
      
      if (retries < MAX_RETRIES) {
        const backoff = INITIAL_BACKOFF * Math.pow(2, retries);
        logger.warn({
          instanceId: payload.instanceId,
          event: payload.event,
          webhook: url,
          retry: retries + 1,
          backoffMs: backoff,
          error: axiosError.message
        }, 'Webhook delivery failed, retrying...');
        
        await new Promise(resolve => setTimeout(resolve, backoff));
        return this.sendWithRetry(url, payload, retries + 1);
      }
      
      logger.error({
        instanceId: payload.instanceId,
        event: payload.event,
        webhook: url,
        error: axiosError.message
      }, 'Webhook delivery failed after max retries');
      
      return false;
    }
  }

  static async dispatch(url: string, instanceId: string, event: string, payload: any): Promise<boolean> {
    if (!url) {
      logger.debug({ instanceId, event }, 'No webhook URL configured, skipping dispatch');
      return false;
    }

    // Deduplicate message.received events using messageId
    // Baileys uses payload.messageId, but also check payload.key?.id for compatibility
    if (event === 'message.received') {
      const messageId = payload?.messageId || payload?.key?.id;
      
      if (messageId) {
        const dedupKey = `${instanceId}:${messageId}`;
        
        if (processedMessages.has(dedupKey)) {
          logger.debug({ instanceId, event, messageId }, 'Duplicate message detected, skipping webhook dispatch');
          return false;
        }
        
        processedMessages.set(dedupKey, Date.now());
      }
    }

    const webhookPayload: WebhookPayload = {
      instanceId,
      event,
      payload,
      timestamp: new Date().toISOString()
    };

    return this.sendWithRetry(url, webhookPayload);
  }
}

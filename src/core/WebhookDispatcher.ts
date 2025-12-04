import axios, { AxiosError } from 'axios';
import logger from '../utils/logger';
import { WebhookPayload } from '../utils/types';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF = 1000;

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

    const webhookPayload: WebhookPayload = {
      instanceId,
      event,
      payload,
      timestamp: new Date().toISOString()
    };

    return this.sendWithRetry(url, webhookPayload);
  }
}

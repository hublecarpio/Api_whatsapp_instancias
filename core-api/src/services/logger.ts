import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

export const logger = pino({
  level: logLevel,
  formatters: {
    level: (label: string) => ({ level: label }),
    bindings: () => ({})
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProduction ? {} : {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
      }
    }
  })
});

export function createWebhookLogger(phoneNumberId: string, instanceId?: string, provider?: string) {
  return logger.child({
    module: 'webhook',
    phoneNumberId,
    instanceId,
    provider
  });
}

export function createApiLogger(module: string) {
  return logger.child({ module });
}

export const webhookLogger = createApiLogger('meta-webhook');
export const messageLogger = createApiLogger('message-ingest');
export const metaServiceLogger = createApiLogger('meta-service');

export interface WebhookEventLog {
  eventType: 'message_received' | 'message_sent' | 'status_update' | 'media_download' | 'media_upload' | 'error';
  phoneNumberId: string;
  instanceId?: string;
  businessId?: string;
  provider?: string;
  messageId?: string;
  from?: string;
  to?: string;
  messageType?: string;
  mediaId?: string;
  mediaType?: string;
  status?: string;
  error?: string;
  duration?: number;
  metadata?: Record<string, any>;
}

export function logWebhookEvent(event: WebhookEventLog) {
  const logData = {
    ...event,
    timestamp: new Date().toISOString()
  };
  
  if (event.eventType === 'error') {
    webhookLogger.error(logData, `[${event.phoneNumberId}] ${event.eventType}: ${event.error}`);
  } else {
    webhookLogger.info(logData, `[${event.phoneNumberId}] ${event.eventType}`);
  }
}

export default logger;

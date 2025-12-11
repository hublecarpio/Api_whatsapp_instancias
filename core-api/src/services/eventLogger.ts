import prisma from './prisma.js';
import { SystemEventType, EventSeverity } from '@prisma/client';

interface LogEventParams {
  eventType: SystemEventType;
  severity?: EventSeverity;
  source: string;
  message: string;
  userId?: string;
  businessId?: string;
  instanceId?: string;
  details?: Record<string, any>;
  metadata?: Record<string, any>;
  ip?: string;
  userAgent?: string;
  duration?: number;
}

class EventLogger {
  async log(params: LogEventParams): Promise<void> {
    try {
      await prisma.systemEvent.create({
        data: {
          eventType: params.eventType,
          severity: params.severity || 'INFO',
          source: params.source,
          message: params.message,
          userId: params.userId,
          businessId: params.businessId,
          instanceId: params.instanceId,
          details: params.details,
          metadata: params.metadata,
          ip: params.ip,
          userAgent: params.userAgent,
          duration: params.duration
        }
      });
    } catch (error) {
      console.error('[EventLogger] Failed to log event:', error);
    }
  }

  async info(source: string, message: string, extra?: Partial<LogEventParams>): Promise<void> {
    await this.log({
      eventType: extra?.eventType || 'SYSTEM_ERROR',
      severity: 'INFO',
      source,
      message,
      ...extra
    });
  }

  async warning(source: string, message: string, extra?: Partial<LogEventParams>): Promise<void> {
    await this.log({
      eventType: extra?.eventType || 'SYSTEM_ERROR',
      severity: 'WARNING',
      source,
      message,
      ...extra
    });
  }

  async error(source: string, message: string, extra?: Partial<LogEventParams>): Promise<void> {
    await this.log({
      eventType: extra?.eventType || 'SYSTEM_ERROR',
      severity: 'ERROR',
      source,
      message,
      ...extra
    });
  }

  async critical(source: string, message: string, extra?: Partial<LogEventParams>): Promise<void> {
    await this.log({
      eventType: extra?.eventType || 'SYSTEM_ERROR',
      severity: 'CRITICAL',
      source,
      message,
      ...extra
    });
  }

  async userRegistered(userId: string, email: string, referralCode?: string): Promise<void> {
    await this.log({
      eventType: 'USER_REGISTERED',
      severity: 'INFO',
      source: 'auth',
      message: `New user registered: ${email}`,
      userId,
      details: { email, referralCode }
    });
  }

  async userLogin(userId: string, email: string, ip?: string): Promise<void> {
    await this.log({
      eventType: 'USER_LOGIN',
      severity: 'INFO',
      source: 'auth',
      message: `User logged in: ${email}`,
      userId,
      ip
    });
  }

  async instanceConnected(instanceId: string, businessId: string, phoneNumber?: string): Promise<void> {
    await this.log({
      eventType: 'INSTANCE_CONNECTED',
      severity: 'INFO',
      source: 'whatsapp',
      message: `WhatsApp instance connected: ${phoneNumber || instanceId}`,
      businessId,
      instanceId,
      details: { phoneNumber }
    });
  }

  async instanceError(instanceId: string, businessId: string, error: string): Promise<void> {
    await this.log({
      eventType: 'INSTANCE_ERROR',
      severity: 'ERROR',
      source: 'whatsapp',
      message: `WhatsApp instance error: ${error}`,
      businessId,
      instanceId,
      details: { error }
    });
  }

  async messageSent(businessId: string, instanceId: string, recipient: string): Promise<void> {
    await this.log({
      eventType: 'MESSAGE_SENT',
      severity: 'DEBUG',
      source: 'whatsapp',
      message: `Message sent to ${recipient}`,
      businessId,
      instanceId,
      details: { recipient }
    });
  }

  async messageReceived(businessId: string, instanceId: string, sender: string): Promise<void> {
    await this.log({
      eventType: 'MESSAGE_RECEIVED',
      severity: 'DEBUG',
      source: 'whatsapp',
      message: `Message received from ${sender}`,
      businessId,
      instanceId,
      details: { sender }
    });
  }

  async aiResponse(businessId: string, model: string, tokens: number, duration: number): Promise<void> {
    await this.log({
      eventType: 'AI_RESPONSE',
      severity: 'DEBUG',
      source: 'ai',
      message: `AI response generated using ${model}`,
      businessId,
      duration,
      details: { model, tokens }
    });
  }

  async aiError(businessId: string, error: string): Promise<void> {
    await this.log({
      eventType: 'AI_ERROR',
      severity: 'ERROR',
      source: 'ai',
      message: `AI error: ${error}`,
      businessId,
      details: { error }
    });
  }

  async orderCreated(businessId: string, orderId: string, amount: number): Promise<void> {
    await this.log({
      eventType: 'ORDER_CREATED',
      severity: 'INFO',
      source: 'orders',
      message: `Order created: ${orderId}`,
      businessId,
      details: { orderId, amount }
    });
  }

  async paymentSuccess(businessId: string, orderId: string, amount: number): Promise<void> {
    await this.log({
      eventType: 'PAYMENT_SUCCESS',
      severity: 'INFO',
      source: 'payments',
      message: `Payment successful for order ${orderId}`,
      businessId,
      details: { orderId, amount }
    });
  }

  async toolExecuted(businessId: string, toolName: string, success: boolean, duration: number): Promise<void> {
    await this.log({
      eventType: success ? 'TOOL_EXECUTED' : 'TOOL_ERROR',
      severity: success ? 'DEBUG' : 'WARNING',
      source: 'tools',
      message: `Tool ${toolName} ${success ? 'executed' : 'failed'}`,
      businessId,
      duration,
      details: { toolName, success }
    });
  }

  async webhookReceived(source: string, eventType: string, businessId?: string): Promise<void> {
    await this.log({
      eventType: 'WEBHOOK_RECEIVED',
      severity: 'DEBUG',
      source: `webhook:${source}`,
      message: `Webhook received: ${eventType}`,
      businessId,
      details: { eventType }
    });
  }
}

export const eventLogger = new EventLogger();
export default eventLogger;

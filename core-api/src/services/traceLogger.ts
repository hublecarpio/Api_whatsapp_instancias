import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

export interface TraceStep {
  step: string;
  timestamp: string;
  durationMs?: number;
  data?: Record<string, any>;
  error?: string;
  status: 'ok' | 'error' | 'skipped';
}

export class TraceLogger {
  private traceId: string;
  private businessId: string;
  private instanceId?: string;
  private contactPhone: string;
  private provider?: string;
  private steps: TraceStep[] = [];
  private startTime: number;
  private created = false;
  private userMessage?: string;

  constructor(opts: {
    traceId?: string;
    businessId: string;
    instanceId?: string;
    contactPhone: string;
    provider?: string;
    userMessage?: string;
  }) {
    this.traceId = opts.traceId || `trc_${crypto.randomBytes(8).toString('hex')}`;
    this.businessId = opts.businessId;
    this.instanceId = opts.instanceId;
    this.contactPhone = opts.contactPhone;
    this.provider = opts.provider;
    this.startTime = Date.now();
    this.userMessage = opts.userMessage;
  }

  getTraceId(): string {
    return this.traceId;
  }

  private async ensureCreated(): Promise<void> {
    if (this.created) return;
    this.created = true;
    try {
      await prisma.messageTrace.create({
        data: {
          traceId: this.traceId,
          businessId: this.businessId,
          instanceId: this.instanceId || null,
          contactPhone: this.contactPhone,
          provider: this.provider || null,
          status: 'pending',
          steps: [],
          userMessage: this.userMessage || null,
          startedAt: new Date(this.startTime),
        }
      });
    } catch (err: any) {
      console.error(`[TRACE:${this.traceId}] Failed to create trace record:`, err.message);
    }
  }

  async addStep(step: string, data?: Record<string, any>, status: 'ok' | 'error' | 'skipped' = 'ok', error?: string): Promise<void> {
    const entry: TraceStep = {
      step,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - this.startTime,
      data: data ? this.sanitizeData(data) : undefined,
      error,
      status,
    };
    this.steps.push(entry);

    this.persistSteps().catch(err => {
      console.error(`[TRACE:${this.traceId}] Failed to persist step "${step}":`, err.message);
    });
  }

  async addError(step: string, error: any, data?: Record<string, any>): Promise<void> {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await this.addStep(step, data, 'error', errorMsg);
  }

  async complete(aiResponse?: string): Promise<void> {
    const duration = Date.now() - this.startTime;
    try {
      await this.ensureCreated();
      await prisma.messageTrace.update({
        where: { traceId: this.traceId },
        data: {
          status: 'completed',
          steps: this.steps as any,
          aiResponse: aiResponse ? aiResponse.substring(0, 2000) : null,
          completedAt: new Date(),
          durationMs: duration,
        }
      });
    } catch (err: any) {
      console.error(`[TRACE:${this.traceId}] Failed to complete trace:`, err.message);
    }
  }

  async fail(errorSummary: string): Promise<void> {
    const duration = Date.now() - this.startTime;
    try {
      await this.ensureCreated();
      await prisma.messageTrace.update({
        where: { traceId: this.traceId },
        data: {
          status: 'failed',
          steps: this.steps as any,
          errorSummary: errorSummary.substring(0, 500),
          completedAt: new Date(),
          durationMs: duration,
        }
      });
    } catch (err: any) {
      console.error(`[TRACE:${this.traceId}] Failed to mark trace as failed:`, err.message);
    }
  }

  private async persistSteps(): Promise<void> {
    await this.ensureCreated();
    try {
      await prisma.messageTrace.update({
        where: { traceId: this.traceId },
        data: {
          steps: this.steps as any,
        }
      });
    } catch (err: any) {
      // silent - non-critical
    }
  }

  private sanitizeData(data: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (['accessToken', 'token', 'secret', 'password', 'apiKey'].some(s => key.toLowerCase().includes(s.toLowerCase()))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'string' && value.length > 500) {
        sanitized[key] = value.substring(0, 500) + '...[truncated]';
      } else if (typeof value === 'object' && value !== null) {
        try {
          const json = JSON.stringify(value);
          sanitized[key] = json.length > 1000 ? JSON.parse(json.substring(0, 1000) + '..."') : value;
        } catch {
          sanitized[key] = '[complex object]';
        }
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}

export function createTraceId(): string {
  return `trc_${crypto.randomBytes(8).toString('hex')}`;
}

export async function getTraceByTraceId(traceId: string) {
  return prisma.messageTrace.findUnique({ where: { traceId } });
}

export async function getTraces(filters: {
  businessId?: string;
  contactPhone?: string;
  status?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}) {
  const where: any = {};
  if (filters.businessId) where.businessId = filters.businessId;
  if (filters.contactPhone) where.contactPhone = { contains: filters.contactPhone };
  if (filters.status) where.status = filters.status;
  if (filters.from || filters.to) {
    where.startedAt = {};
    if (filters.from) where.startedAt.gte = filters.from;
    if (filters.to) where.startedAt.lte = filters.to;
  }

  const [traces, total] = await Promise.all([
    prisma.messageTrace.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: filters.limit || 50,
      skip: filters.offset || 0,
    }),
    prisma.messageTrace.count({ where }),
  ]);

  return { traces, total };
}

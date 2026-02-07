import { Router, Response } from 'express';
import { getTraces, getTraceByTraceId } from '../services/traceLogger.js';
import { SuperAdminRequest, superAdminMiddleware } from '../middleware/superAdmin.js';
import prisma from '../services/prisma.js';
import { processWebhookPayload } from './metaWebhook.js';

const router = Router();

router.get('/', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const {
      businessId,
      contactPhone,
      status,
      from,
      to,
      limit,
      offset
    } = req.query;

    const filters: any = {};
    if (businessId) filters.businessId = businessId as string;
    if (contactPhone) filters.contactPhone = contactPhone as string;
    if (status) filters.status = status as string;
    if (from) filters.from = new Date(from as string);
    if (to) filters.to = new Date(to as string);
    if (limit) filters.limit = parseInt(limit as string, 10);
    if (offset) filters.offset = parseInt(offset as string, 10);

    const result = await getTraces(filters);

    res.json({
      success: true,
      traces: result.traces,
      total: result.total,
      filters: {
        businessId: businessId || null,
        contactPhone: contactPhone || null,
        status: status || null,
        from: from || null,
        to: to || null,
        limit: filters.limit || 50,
        offset: filters.offset || 0
      }
    });
  } catch (error: any) {
    console.error('[Traces API] Error listing traces:', error.message);
    res.status(500).json({ error: 'Failed to fetch traces' });
  }
});

router.get('/stats', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { businessId, from, to } = req.query;

    const where: any = {};
    if (businessId) where.businessId = businessId;
    if (from || to) {
      where.startedAt = {};
      if (from) where.startedAt.gte = new Date(from as string);
      if (to) where.startedAt.lte = new Date(to as string);
    }

    const [total, completed, failed, pending] = await Promise.all([
      prisma.messageTrace.count({ where }),
      prisma.messageTrace.count({ where: { ...where, status: 'completed' } }),
      prisma.messageTrace.count({ where: { ...where, status: 'failed' } }),
      prisma.messageTrace.count({ where: { ...where, status: 'pending' } }),
    ]);

    const avgDuration = await prisma.messageTrace.aggregate({
      where: { ...where, status: 'completed', durationMs: { not: null } },
      _avg: { durationMs: true },
      _max: { durationMs: true },
      _min: { durationMs: true },
    });

    res.json({
      success: true,
      stats: {
        total,
        completed,
        failed,
        pending,
        successRate: total > 0 ? ((completed / total) * 100).toFixed(1) + '%' : 'N/A',
        avgDurationMs: Math.round(avgDuration._avg.durationMs || 0),
        maxDurationMs: avgDuration._max.durationMs || 0,
        minDurationMs: avgDuration._min.durationMs || 0,
      }
    });
  } catch (error: any) {
    console.error('[Traces API] Error fetching stats:', error.message);
    res.status(500).json({ error: 'Failed to fetch trace stats' });
  }
});

router.get('/:traceId', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { traceId } = req.params;
    const trace = await getTraceByTraceId(traceId);

    if (!trace) {
      return res.status(404).json({ error: 'Trace not found' });
    }

    res.json({
      success: true,
      trace
    });
  } catch (error: any) {
    console.error('[Traces API] Error fetching trace:', error.message);
    res.status(500).json({ error: 'Failed to fetch trace' });
  }
});

router.get('/webhooks/failed', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { hours = '24', limit = '50' } = req.query;
    const since = new Date(Date.now() - parseInt(hours as string) * 3600000);

    const failed = await prisma.webhookRawLog.findMany({
      where: {
        createdAt: { gte: since },
        OR: [
          { processingError: { not: null } },
          { processedAt: null, createdAt: { lte: new Date(Date.now() - 60000) } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit as string) || 50, 200),
      select: {
        id: true,
        source: true,
        phoneNumberId: true,
        businessId: true,
        messageCount: true,
        statusCount: true,
        processingError: true,
        processedAt: true,
        createdAt: true
      }
    });

    const stats = {
      total: failed.length,
      withError: failed.filter(f => f.processingError).length,
      orphaned: failed.filter(f => !f.processedAt && !f.processingError).length,
      since: since.toISOString()
    };

    res.json({ success: true, stats, data: failed });
  } catch (error: any) {
    console.error('[Traces API] Error fetching failed webhooks:', error.message);
    res.status(500).json({ error: 'Failed to fetch failed webhooks' });
  }
});

router.post('/webhooks/replay/:id', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { id } = req.params;

    const rawLog = await prisma.webhookRawLog.findUnique({ where: { id } });
    if (!rawLog) {
      return res.status(404).json({ error: 'Webhook log not found' });
    }

    if (!rawLog.processingError && rawLog.processedAt) {
      return res.status(400).json({ error: 'This webhook was already processed successfully' });
    }

    console.log(`[REPLAY] Replaying webhook ${id} (original error: ${rawLog.processingError})`);

    try {
      await processWebhookPayload(rawLog.body as any);
      await prisma.webhookRawLog.update({
        where: { id },
        data: { processedAt: new Date(), processingError: null }
      });
      console.log(`[REPLAY] Webhook ${id} replayed successfully`);
      res.json({ success: true, message: 'Webhook replayed successfully' });
    } catch (replayError: any) {
      await prisma.webhookRawLog.update({
        where: { id },
        data: { processingError: `Replay failed: ${replayError.message}`, processedAt: new Date() }
      }).catch(() => {});
      console.error(`[REPLAY] Webhook ${id} replay failed:`, replayError.message);
      res.status(500).json({ success: false, error: `Replay failed: ${replayError.message}` });
    }
  } catch (error: any) {
    console.error('[Traces API] Error replaying webhook:', error.message);
    res.status(500).json({ error: 'Failed to replay webhook' });
  }
});

router.post('/webhooks/replay-all', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { hours = '24' } = req.body;
    const since = new Date(Date.now() - parseInt(hours as string) * 3600000);

    const failed = await prisma.webhookRawLog.findMany({
      where: {
        createdAt: { gte: since },
        processingError: { not: null },
        messageCount: { gt: 0 }
      },
      orderBy: { createdAt: 'asc' },
      take: 100
    });

    let replayed = 0;
    let errors = 0;

    for (const rawLog of failed) {
      try {
        await processWebhookPayload(rawLog.body as any);
        await prisma.webhookRawLog.update({
          where: { id: rawLog.id },
          data: { processedAt: new Date(), processingError: null }
        });
        replayed++;
      } catch (replayError: any) {
        errors++;
        await prisma.webhookRawLog.update({
          where: { id: rawLog.id },
          data: { processingError: `Replay failed: ${replayError.message}`, processedAt: new Date() }
        }).catch(() => {});
      }
    }

    console.log(`[REPLAY-ALL] Replayed ${replayed}/${failed.length} webhooks (${errors} errors)`);
    res.json({ success: true, total: failed.length, replayed, errors });
  } catch (error: any) {
    console.error('[Traces API] Error in replay-all:', error.message);
    res.status(500).json({ error: 'Failed to replay webhooks' });
  }
});

export default router;

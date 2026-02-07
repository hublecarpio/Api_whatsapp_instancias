import { Router, Response } from 'express';
import { getTraces, getTraceByTraceId } from '../services/traceLogger.js';
import { SuperAdminRequest, superAdminMiddleware } from '../middleware/superAdmin.js';
import prisma from '../services/prisma.js';

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

export default router;

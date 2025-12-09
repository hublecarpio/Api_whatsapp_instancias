import { Router, Response } from 'express';
import prisma from '../services/prisma.js';
import { 
  SuperAdminRequest, 
  superAdminMiddleware, 
  isSuperAdminConfigured,
  validateSuperAdminCredentials,
  createSuperAdminSession,
  revokeSuperAdminSession
} from '../middleware/superAdmin.js';

const router = Router();

router.post('/login', async (req: SuperAdminRequest, res: Response) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    if (!isSuperAdminConfigured()) {
      return res.status(503).json({ error: 'Super admin not configured' });
    }
    
    if (!validateSuperAdminCredentials(username, password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const session = await createSuperAdminSession();
    
    res.json({
      success: true,
      token: session.token,
      expiresAt: session.expiresAt
    });
  } catch (error: any) {
    console.error('Super admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/logout', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.substring(7);
    await revokeSuperAdminSession(token);
  }
  res.json({ success: true });
});

router.get('/overview', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thisWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const [
      totalUsers,
      totalBusinesses,
      totalInstances,
      activeInstances,
      messagesToday,
      messagesThisWeek,
      subscriptionStats,
      tokenUsageToday,
      tokenUsageThisMonth
    ] = await Promise.all([
      prisma.user.count(),
      prisma.business.count(),
      prisma.whatsAppInstance.count(),
      prisma.whatsAppInstance.count({ where: { status: 'open' } }),
      prisma.messageLog.count({ where: { createdAt: { gte: today } } }),
      prisma.messageLog.count({ where: { createdAt: { gte: thisWeek } } }),
      prisma.user.groupBy({
        by: ['subscriptionStatus'],
        _count: true
      }),
      prisma.tokenUsage.aggregate({
        where: { createdAt: { gte: today } },
        _sum: { totalTokens: true, costUsd: true }
      }),
      prisma.tokenUsage.aggregate({
        where: { createdAt: { gte: thisMonth } },
        _sum: { totalTokens: true, costUsd: true }
      })
    ]);
    
    const subscriptionBreakdown = subscriptionStats.reduce<Record<string, number>>((acc, s) => {
      acc[s.subscriptionStatus] = s._count;
      return acc;
    }, {});
    
    res.json({
      users: {
        total: totalUsers,
        bySubscription: subscriptionBreakdown
      },
      businesses: {
        total: totalBusinesses
      },
      instances: {
        total: totalInstances,
        active: activeInstances,
        inactive: totalInstances - activeInstances
      },
      messages: {
        today: messagesToday,
        thisWeek: messagesThisWeek
      },
      tokenUsage: {
        today: {
          tokens: tokenUsageToday._sum.totalTokens || 0,
          cost: tokenUsageToday._sum.costUsd || 0
        },
        thisMonth: {
          tokens: tokenUsageThisMonth._sum.totalTokens || 0,
          cost: tokenUsageThisMonth._sum.costUsd || 0
        }
      }
    });
  } catch (error: any) {
    console.error('Overview error:', error);
    res.status(500).json({ error: 'Failed to get overview' });
  }
});

router.get('/users', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    
    const where: any = {};
    if (status) {
      where.subscriptionStatus = status;
    }
    
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          email: true,
          emailVerified: true,
          subscriptionStatus: true,
          trialEndAt: true,
          createdAt: true,
          _count: {
            select: { businesses: true }
          }
        }
      }),
      prisma.user.count({ where })
    ]);
    
    res.json({
      users,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error: any) {
    console.error('Users list error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

router.get('/users/:id', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        businesses: {
          include: {
            instances: true,
            _count: {
              select: { messages: true, products: true }
            }
          }
        }
      }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const tokenUsage = await prisma.tokenUsage.aggregate({
      where: { userId: user.id },
      _sum: { totalTokens: true, costUsd: true }
    });
    
    res.json({
      ...user,
      passwordHash: undefined,
      tokenUsage: {
        totalTokens: tokenUsage._sum.totalTokens || 0,
        totalCost: tokenUsage._sum.costUsd || 0
      }
    });
  } catch (error: any) {
    console.error('User detail error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

router.get('/businesses', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    
    const [businesses, total] = await Promise.all([
      prisma.business.findMany({
        skip,
        take: Number(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, name: true, email: true, subscriptionStatus: true }
          },
          instances: {
            select: { id: true, status: true, provider: true }
          },
          _count: {
            select: { messages: true, products: true }
          }
        }
      }),
      prisma.business.count()
    ]);
    
    res.json({
      businesses,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error: any) {
    console.error('Businesses list error:', error);
    res.status(500).json({ error: 'Failed to get businesses' });
  }
});

router.get('/token-usage', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;
    
    const where: any = {};
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate as string);
      if (endDate) where.createdAt.lte = new Date(endDate as string);
    }
    
    const usage = await prisma.tokenUsage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 1000
    });
    
    interface TokenTotals {
      totalTokens: number;
      promptTokens: number;
      completionTokens: number;
      totalCost: number;
    }
    
    interface UsageData {
      tokens: number;
      cost: number;
    }
    
    const totals = usage.reduce<TokenTotals>((acc, u) => ({
      totalTokens: acc.totalTokens + u.totalTokens,
      promptTokens: acc.promptTokens + u.promptTokens,
      completionTokens: acc.completionTokens + u.completionTokens,
      totalCost: acc.totalCost + u.costUsd
    }), { totalTokens: 0, promptTokens: 0, completionTokens: 0, totalCost: 0 });
    
    const byBusiness = usage.reduce<Record<string, UsageData>>((acc, u) => {
      if (!acc[u.businessId]) {
        acc[u.businessId] = { tokens: 0, cost: 0 };
      }
      acc[u.businessId].tokens += u.totalTokens;
      acc[u.businessId].cost += u.costUsd;
      return acc;
    }, {});
    
    const topBusinesses = Object.entries(byBusiness)
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, 10)
      .map(([businessId, data]) => ({ businessId, tokens: data.tokens, cost: data.cost }));
    
    const byFeature = usage.reduce<Record<string, UsageData>>((acc, u) => {
      if (!acc[u.feature]) {
        acc[u.feature] = { tokens: 0, cost: 0 };
      }
      acc[u.feature].tokens += u.totalTokens;
      acc[u.feature].cost += u.costUsd;
      return acc;
    }, {});
    
    res.json({
      totals: {
        ...totals,
        totalCost: parseFloat(totals.totalCost.toFixed(4))
      },
      topBusinesses,
      byFeature: Object.entries(byFeature).map(([feature, data]) => ({
        feature,
        tokens: data.tokens,
        cost: parseFloat(data.cost.toFixed(4))
      }))
    });
  } catch (error: any) {
    console.error('Token usage error:', error);
    res.status(500).json({ error: 'Failed to get token usage' });
  }
});

router.get('/messages/stats', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const thisWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    const [
      totalMessages,
      inboundToday,
      outboundToday,
      inboundYesterday,
      outboundYesterday,
      inboundThisWeek,
      outboundThisWeek
    ] = await Promise.all([
      prisma.messageLog.count(),
      prisma.messageLog.count({ where: { direction: 'inbound', createdAt: { gte: today } } }),
      prisma.messageLog.count({ where: { direction: 'outbound', createdAt: { gte: today } } }),
      prisma.messageLog.count({ where: { direction: 'inbound', createdAt: { gte: yesterday, lt: today } } }),
      prisma.messageLog.count({ where: { direction: 'outbound', createdAt: { gte: yesterday, lt: today } } }),
      prisma.messageLog.count({ where: { direction: 'inbound', createdAt: { gte: thisWeek } } }),
      prisma.messageLog.count({ where: { direction: 'outbound', createdAt: { gte: thisWeek } } })
    ]);
    
    res.json({
      total: totalMessages,
      today: {
        inbound: inboundToday,
        outbound: outboundToday,
        total: inboundToday + outboundToday
      },
      yesterday: {
        inbound: inboundYesterday,
        outbound: outboundYesterday,
        total: inboundYesterday + outboundYesterday
      },
      thisWeek: {
        inbound: inboundThisWeek,
        outbound: outboundThisWeek,
        total: inboundThisWeek + outboundThisWeek
      }
    });
  } catch (error: any) {
    console.error('Message stats error:', error);
    res.status(500).json({ error: 'Failed to get message stats' });
  }
});

router.get('/instances', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const instances = await prisma.whatsAppInstance.findMany({
      include: {
        business: {
          include: {
            user: {
              select: { id: true, name: true, email: true }
            }
          }
        }
      },
      orderBy: { lastConnection: 'desc' }
    });
    
    const statusCounts = instances.reduce((acc, i) => {
      acc[i.status] = (acc[i.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    res.json({
      instances,
      summary: {
        total: instances.length,
        byStatus: statusCounts
      }
    });
  } catch (error: any) {
    console.error('Instances error:', error);
    res.status(500).json({ error: 'Failed to get instances' });
  }
});

router.get('/billing', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        subscriptionStatus: { not: 'PENDING' }
      },
      select: {
        id: true,
        name: true,
        email: true,
        subscriptionStatus: true,
        trialEndAt: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        createdAt: true
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const now = new Date();
    const trialEnding = users.filter(u => 
      u.subscriptionStatus === 'TRIAL' && 
      u.trialEndAt && 
      u.trialEndAt.getTime() - now.getTime() < 2 * 24 * 60 * 60 * 1000
    );
    
    const statusCounts = users.reduce((acc, u) => {
      acc[u.subscriptionStatus] = (acc[u.subscriptionStatus] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    res.json({
      users,
      summary: {
        total: users.length,
        byStatus: statusCounts,
        trialEndingSoon: trialEnding.length
      }
    });
  } catch (error: any) {
    console.error('Billing error:', error);
    res.status(500).json({ error: 'Failed to get billing info' });
  }
});

router.get('/system-health', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const dbHealthy = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    
    const openaiConfigured = !!process.env.OPENAI_API_KEY;
    const stripeConfigured = !!process.env.STRIPE_SECRET_KEY;
    const redisConfigured = !!process.env.REDIS_URL;
    
    res.json({
      status: dbHealthy ? 'healthy' : 'degraded',
      services: {
        database: dbHealthy ? 'connected' : 'disconnected',
        openai: openaiConfigured ? 'configured' : 'not_configured',
        stripe: stripeConfigured ? 'configured' : 'not_configured',
        redis: redisConfigured ? 'configured' : 'not_configured'
      },
      environment: process.env.NODE_ENV || 'development',
      uptime: process.uptime()
    });
  } catch (error: any) {
    console.error('System health error:', error);
    res.status(500).json({ error: 'Failed to get system health' });
  }
});

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';

router.get('/wa-instances', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const waResponse = await fetch(`${WA_API_URL}/instances`);
    const waData = await waResponse.json();
    
    if (!waData.success) {
      return res.status(500).json({ error: 'Failed to get WhatsApp API instances' });
    }
    
    const dbInstances = await prisma.whatsAppInstance.findMany({
      include: {
        business: {
          select: { id: true, name: true, user: { select: { email: true } } }
        }
      }
    });
    
    const dbInstanceMap = new Map(dbInstances.map(i => [i.instanceBackendId, i]));
    
    const enrichedInstances = waData.data.instances.map((inst: any) => {
      const dbRecord = dbInstanceMap.get(inst.id);
      return {
        ...inst,
        businessId: dbRecord?.businessId || null,
        businessName: dbRecord?.business?.name || null,
        userEmail: dbRecord?.business?.user?.email || null,
        provider: dbRecord?.provider || 'baileys',
        inDatabase: !!dbRecord
      };
    });
    
    const orphanedInstances = enrichedInstances.filter((i: any) => !i.inDatabase);
    
    res.json({
      instances: enrichedInstances,
      summary: {
        total: enrichedInstances.length,
        connected: enrichedInstances.filter((i: any) => i.status === 'connected').length,
        requiresQr: enrichedInstances.filter((i: any) => i.status === 'requires_qr').length,
        orphaned: orphanedInstances.length
      }
    });
  } catch (error: any) {
    console.error('WA Instances error:', error);
    res.status(500).json({ error: 'Failed to get WhatsApp instances', details: error.message });
  }
});

router.delete('/wa-instances/:instanceId', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    const { deleteFromDb } = req.query;
    
    const waResponse = await fetch(`${WA_API_URL}/instances/${instanceId}`, {
      method: 'DELETE'
    });
    const waData = await waResponse.json();
    
    if (deleteFromDb === 'true') {
      await prisma.whatsAppInstance.deleteMany({
        where: { instanceBackendId: instanceId }
      });
    }
    
    res.json({
      success: true,
      waApiResult: waData,
      deletedFromDb: deleteFromDb === 'true'
    });
  } catch (error: any) {
    console.error('Delete WA instance error:', error);
    res.status(500).json({ error: 'Failed to delete instance', details: error.message });
  }
});

router.post('/wa-instances/:instanceId/restart', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    
    const waResponse = await fetch(`${WA_API_URL}/instances/${instanceId}/restart`, {
      method: 'POST'
    });
    const waData = await waResponse.json();
    
    res.json({
      success: true,
      result: waData
    });
  } catch (error: any) {
    console.error('Restart WA instance error:', error);
    res.status(500).json({ error: 'Failed to restart instance', details: error.message });
  }
});

export default router;

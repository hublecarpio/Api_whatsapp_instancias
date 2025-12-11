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
          isPro: true,
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

router.delete('/users/:id', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const userId = req.params.id;
    
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { businesses: true }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const businessIds = user.businesses.map(b => b.id);
    
    await prisma.$transaction(async (tx) => {
      await tx.tokenUsage.deleteMany({ where: { userId } });
      await tx.tokenUsage.deleteMany({ where: { businessId: { in: businessIds } } });
      
      await tx.contactExtractedData.deleteMany({ where: { businessId: { in: businessIds } } });
      await tx.extractionField.deleteMany({ where: { businessId: { in: businessIds } } });
      await tx.paymentLinkRequest.deleteMany({ where: { businessId: { in: businessIds } } });
      await tx.contactSettings.deleteMany({ where: { businessId: { in: businessIds } } });
      await tx.messageBuffer.deleteMany({ where: { businessId: { in: businessIds } } });
      await tx.tagHistory.deleteMany({ where: { businessId: { in: businessIds } } });
      await tx.tagAssignment.deleteMany({ where: { businessId: { in: businessIds } } });
      
      await tx.learnedRule.deleteMany({ where: { businessId: { in: businessIds } } });
      await tx.leadMemory.deleteMany({ where: { businessId: { in: businessIds } } });
      await tx.agentV2Config.deleteMany({ where: { businessId: { in: businessIds } } });
      
      await tx.orderItem.deleteMany({ 
        where: { order: { businessId: { in: businessIds } } } 
      });
      await tx.order.deleteMany({ where: { businessId: { in: businessIds } } });
      await tx.paymentSession.deleteMany({ where: { businessId: { in: businessIds } } });
      
      await tx.user.delete({ where: { id: userId } });
    });
    
    console.log(`[Super Admin] User deleted: ${user.email} (${user.businesses.length} businesses removed)`);
    
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error: any) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user', details: error.message });
  }
});

router.patch('/users/:id/pro', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const userId = req.params.id;
    const { isPro } = req.body;
    
    if (typeof isPro !== 'boolean') {
      return res.status(400).json({ error: 'isPro must be a boolean' });
    }
    
    const user = await prisma.user.update({
      where: { id: userId },
      data: { isPro },
      select: {
        id: true,
        name: true,
        email: true,
        isPro: true
      }
    });
    
    if (isPro) {
      console.log(`[Super Admin] User upgraded to Pro: ${user.email}`);
    } else {
      console.log(`[Super Admin] User downgraded from Pro: ${user.email}`);
    }
    
    res.json({ success: true, user });
  } catch (error: any) {
    console.error('Toggle Pro error:', error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'User not found' });
    }
    res.status(500).json({ error: 'Failed to toggle Pro status' });
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

    const byProvider = usage.reduce<Record<string, UsageData>>((acc, u) => {
      const provider = u.provider || 'openai';
      if (!acc[provider]) {
        acc[provider] = { tokens: 0, cost: 0 };
      }
      acc[provider].tokens += u.totalTokens;
      acc[provider].cost += u.costUsd;
      return acc;
    }, {});

    const byModel = usage.reduce<Record<string, UsageData>>((acc, u) => {
      const key = `${u.provider || 'openai'}/${u.model}`;
      if (!acc[key]) {
        acc[key] = { tokens: 0, cost: 0 };
      }
      acc[key].tokens += u.totalTokens;
      acc[key].cost += u.costUsd;
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
      })),
      byProvider: Object.entries(byProvider).map(([provider, data]) => ({
        provider,
        tokens: data.tokens,
        cost: parseFloat(data.cost.toFixed(4))
      })),
      byModel: Object.entries(byModel).map(([model, data]) => ({
        model,
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
    // Get all instances from database (both Baileys and Meta Cloud)
    const dbInstances = await prisma.whatsAppInstance.findMany({
      include: {
        business: {
          select: { id: true, name: true, user: { select: { email: true } } }
        }
      }
    });
    
    // Try to get Baileys instances from WA API
    let baileysInstances: any[] = [];
    try {
      const waResponse = await fetch(`${WA_API_URL}/instances`);
      const waData = await waResponse.json();
      if (waData.success) {
        baileysInstances = waData.data.instances || [];
      }
    } catch (err) {
      console.log('Could not connect to WhatsApp API, showing only database instances');
    }
    
    const baileysInstanceMap = new Map(baileysInstances.map((i: any) => [i.id, i]));
    const processedBackendIds = new Set<string>();
    
    // First, process Baileys instances from WA API
    const enrichedBaileysInstances = baileysInstances.map((inst: any) => {
      const dbRecord = dbInstances.find(d => d.instanceBackendId === inst.id);
      processedBackendIds.add(inst.id);
      return {
        ...inst,
        businessId: dbRecord?.businessId || null,
        businessName: dbRecord?.business?.name || null,
        userEmail: dbRecord?.business?.user?.email || null,
        phoneNumber: dbRecord?.phoneNumber || inst.phoneNumber,
        provider: 'BAILEYS',
        inDatabase: !!dbRecord
      };
    });
    
    // Then, add Meta Cloud instances from database (they don't exist in WA API)
    const metaCloudInstances = dbInstances
      .filter(inst => inst.provider === 'META_CLOUD')
      .map(inst => ({
        id: inst.id,
        status: inst.status === 'connected' ? 'connected' : inst.status,
        businessId: inst.businessId,
        businessName: inst.business?.name || null,
        userEmail: inst.business?.user?.email || null,
        phoneNumber: inst.phoneNumber,
        provider: 'META_CLOUD',
        inDatabase: true,
        lastConnection: inst.lastConnection
      }));
    
    const allInstances = [...enrichedBaileysInstances, ...metaCloudInstances];
    const orphanedInstances = allInstances.filter((i: any) => !i.inDatabase);
    
    res.json({
      instances: allInstances,
      summary: {
        total: allInstances.length,
        connected: allInstances.filter((i: any) => i.status === 'connected').length,
        requiresQr: allInstances.filter((i: any) => i.status === 'requires_qr').length,
        orphaned: orphanedInstances.length,
        baileys: enrichedBaileysInstances.length,
        metaCloud: metaCloudInstances.length
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

router.get('/analytics/orders', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { businessId, startDate, endDate, status } = req.query;
    
    const dateFilter: any = {};
    if (startDate) {
      dateFilter.gte = new Date(startDate as string);
    }
    if (endDate) {
      const end = new Date(endDate as string);
      end.setHours(23, 59, 59, 999);
      dateFilter.lte = end;
    }
    
    const where: any = {};
    if (businessId) where.businessId = businessId as string;
    if (Object.keys(dateFilter).length > 0) where.createdAt = dateFilter;
    if (status) where.status = status as string;
    
    const [
      ordersByStatus,
      totalOrders,
      totalRevenue,
      recentOrders,
      ordersByBusiness
    ] = await Promise.all([
      prisma.order.groupBy({
        by: ['status'],
        where,
        _count: true,
        _sum: { totalAmount: true }
      }),
      prisma.order.count({ where }),
      prisma.order.aggregate({
        where: { ...where, status: 'PAID' },
        _sum: { totalAmount: true }
      }),
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { items: true }
      }),
      prisma.order.groupBy({
        by: ['businessId'],
        where,
        _count: true,
        _sum: { totalAmount: true }
      })
    ]);
    
    const orderBusinessIds = [...new Set([...ordersByBusiness.map(b => b.businessId), ...recentOrders.map(o => o.businessId)])];
    const businesses = await prisma.business.findMany({
      where: { id: { in: orderBusinessIds } },
      select: { id: true, name: true }
    });
    const businessMap = new Map(businesses.map(b => [b.id, b.name]));
    
    const statusBreakdown = ordersByStatus.reduce<Record<string, { count: number; amount: number }>>((acc, s) => {
      acc[s.status] = {
        count: s._count,
        amount: s._sum.totalAmount || 0
      };
      return acc;
    }, {});
    
    const byBusiness = ordersByBusiness.map(b => ({
      businessId: b.businessId,
      businessName: businessMap.get(b.businessId) || 'Unknown',
      count: b._count,
      totalAmount: b._sum.totalAmount || 0
    })).sort((a, b) => b.count - a.count);
    
    res.json({
      summary: {
        totalOrders,
        totalRevenue: totalRevenue._sum.totalAmount || 0,
        byStatus: statusBreakdown
      },
      byBusiness,
      recentOrders: recentOrders.map(o => ({
        id: o.id,
        status: o.status,
        totalAmount: o.totalAmount,
        currencySymbol: o.currencySymbol,
        contactPhone: o.contactPhone,
        contactName: o.contactName,
        businessName: businessMap.get(o.businessId) || 'Unknown',
        itemCount: o.items.length,
        createdAt: o.createdAt
      }))
    });
  } catch (error: any) {
    console.error('Analytics orders error:', error);
    res.status(500).json({ error: 'Failed to fetch order analytics', details: error.message });
  }
});

router.get('/analytics/payment-links', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { businessId, startDate, endDate, isSuccess } = req.query;
    
    const dateFilter: any = {};
    if (startDate) {
      dateFilter.gte = new Date(startDate as string);
    }
    if (endDate) {
      const end = new Date(endDate as string);
      end.setHours(23, 59, 59, 999);
      dateFilter.lte = end;
    }
    
    const where: any = {};
    if (businessId) where.businessId = businessId as string;
    if (Object.keys(dateFilter).length > 0) where.createdAt = dateFilter;
    if (isSuccess !== undefined) where.isSuccess = isSuccess === 'true';
    
    const [
      totalRequests,
      successCount,
      failureCount,
      requestsByBusiness,
      requestsBySource,
      recentRequests,
      failureReasons
    ] = await Promise.all([
      prisma.paymentLinkRequest.count({ where }),
      prisma.paymentLinkRequest.count({ where: { ...where, isSuccess: true } }),
      prisma.paymentLinkRequest.count({ where: { ...where, isSuccess: false } }),
      prisma.paymentLinkRequest.groupBy({
        by: ['businessId'],
        where,
        _count: true
      }),
      prisma.paymentLinkRequest.groupBy({
        by: ['triggerSource'],
        where,
        _count: true
      }),
      prisma.paymentLinkRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 30
      }),
      prisma.paymentLinkRequest.groupBy({
        by: ['failureReason'],
        where: { ...where, isSuccess: false, failureReason: { not: null } },
        _count: true
      })
    ]);
    
    const businessIds = requestsByBusiness.map(b => b.businessId);
    const businesses = await prisma.business.findMany({
      where: { id: { in: businessIds } },
      select: { id: true, name: true }
    });
    const businessMap = new Map(businesses.map(b => [b.id, b.name]));
    
    const byBusiness = requestsByBusiness.map(b => ({
      businessId: b.businessId,
      businessName: businessMap.get(b.businessId) || 'Unknown',
      count: b._count
    })).sort((a, b) => b.count - a.count);
    
    const bySource = requestsBySource.reduce<Record<string, number>>((acc, s) => {
      acc[s.triggerSource] = s._count;
      return acc;
    }, {});
    
    const topFailureReasons = failureReasons
      .filter(f => f.failureReason)
      .map(f => ({
        reason: f.failureReason,
        count: f._count
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    res.json({
      summary: {
        totalRequests,
        successCount,
        failureCount,
        successRate: totalRequests > 0 ? Math.round((successCount / totalRequests) * 100) : 0
      },
      byBusiness,
      bySource,
      topFailureReasons,
      recentRequests: recentRequests.map(r => ({
        id: r.id,
        businessId: r.businessId,
        businessName: businessMap.get(r.businessId) || 'Unknown',
        contactPhone: r.contactPhone,
        productName: r.productName,
        amount: r.amount,
        quantity: r.quantity,
        isSuccess: r.isSuccess,
        failureReason: r.failureReason,
        isPro: r.isPro,
        triggerSource: r.triggerSource,
        createdAt: r.createdAt
      }))
    });
  } catch (error: any) {
    console.error('Analytics payment links error:', error);
    res.status(500).json({ error: 'Failed to fetch payment link analytics', details: error.message });
  }
});

router.get('/agent-v2-stats', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const v2Businesses = await prisma.business.findMany({
      where: { agentVersion: 'v2' },
      select: {
        id: true,
        name: true,
        userId: true,
        createdAt: true,
        user: { select: { name: true, email: true } }
      }
    });
    
    const businessIds = v2Businesses.map(b => b.id);
    
    const v2Configs = await prisma.agentV2Config.findMany({
      where: { businessId: { in: businessIds } }
    });
    
    const leadMemories = await prisma.leadMemory.findMany({
      where: { businessId: { in: businessIds } }
    });
    
    const learnedRules = await prisma.learnedRule.findMany({
      where: { businessId: { in: businessIds } }
    });
    
    const memoriesByBusiness = leadMemories.reduce((acc, m) => {
      acc[m.businessId] = (acc[m.businessId] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const rulesByBusiness = learnedRules.reduce((acc, r) => {
      acc[r.businessId] = (acc[r.businessId] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const configMap = new Map(v2Configs.map(c => [c.businessId, c]));
    
    const businesses = v2Businesses.map(b => ({
      id: b.id,
      name: b.name,
      userName: b.user?.name || 'Unknown',
      userEmail: b.user?.email || 'Unknown',
      createdAt: b.createdAt,
      memoryCount: memoriesByBusiness[b.id] || 0,
      ruleCount: rulesByBusiness[b.id] || 0,
      skills: configMap.get(b.id)?.skills || null
    }));
    
    const activeRulesCount = learnedRules.filter(r => r.enabled).length;
    const totalAppliedCount = learnedRules.reduce((sum, r) => sum + r.appliedCount, 0);
    
    res.json({
      summary: {
        totalV2Businesses: v2Businesses.length,
        totalLeadMemories: leadMemories.length,
        totalLearnedRules: learnedRules.length,
        activeRulesCount,
        totalRuleApplications: totalAppliedCount
      },
      businesses,
      recentRules: learnedRules
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 20)
        .map(r => ({
          id: r.id,
          businessId: r.businessId,
          rule: r.rule,
          source: r.source,
          enabled: r.enabled,
          appliedCount: r.appliedCount,
          createdAt: r.createdAt
        })),
      recentMemories: leadMemories
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, 20)
        .map(m => ({
          id: m.id,
          businessId: m.businessId,
          leadPhone: m.leadPhone,
          leadName: m.leadName,
          stage: m.stage,
          updatedAt: m.updatedAt
        }))
    });
  } catch (error: any) {
    console.error('Agent V2 stats error:', error);
    res.status(500).json({ error: 'Failed to fetch Agent V2 stats', details: error.message });
  }
});

// ============ REFERRAL CODES ============

router.get('/referral-codes', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const codes = await prisma.referralCode.findMany({
      orderBy: { createdAt: 'desc' }
    });
    
    const usersWithCodes = await prisma.user.groupBy({
      by: ['referralCode'],
      where: { referralCode: { not: null } },
      _count: true
    });
    
    const usageMap = usersWithCodes.reduce<Record<string, number>>((acc, u) => {
      if (u.referralCode) acc[u.referralCode] = u._count;
      return acc;
    }, {});
    
    const codesWithStats = codes.map(c => ({
      ...c,
      registeredUsers: usageMap[c.code] || 0
    }));
    
    res.json({ codes: codesWithStats });
  } catch (error: any) {
    console.error('List referral codes error:', error);
    res.status(500).json({ error: 'Failed to list referral codes' });
  }
});

router.post('/referral-codes', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { code, description, expiresAt, type, grantTier, grantDurationDays, maxUses } = req.body;
    
    if (!code) {
      return res.status(400).json({ error: 'Code is required' });
    }
    
    const upperCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    
    const existing = await prisma.referralCode.findUnique({
      where: { code: upperCode }
    });
    
    if (existing) {
      return res.status(400).json({ error: 'Code already exists' });
    }
    
    if (type === 'ENTERPRISE' && !grantDurationDays) {
      return res.status(400).json({ error: 'Enterprise codes require grantDurationDays' });
    }
    
    const newCode = await prisma.referralCode.create({
      data: {
        code: upperCode,
        description: description || null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        type: type || 'STANDARD',
        grantTier: type === 'ENTERPRISE' ? (grantTier || 'PRO') : null,
        grantDurationDays: type === 'ENTERPRISE' ? grantDurationDays : null,
        maxUses: maxUses || null
      }
    });
    
    console.log(`[Super Admin] Created ${type || 'STANDARD'} referral code: ${upperCode}`);
    
    res.json({ code: newCode });
  } catch (error: any) {
    console.error('Create referral code error:', error);
    res.status(500).json({ error: 'Failed to create referral code' });
  }
});

router.put('/referral-codes/:id', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { description, isActive, expiresAt, type, grantTier, grantDurationDays, maxUses } = req.body;
    
    const code = await prisma.referralCode.update({
      where: { id },
      data: {
        description: description ?? undefined,
        isActive: isActive ?? undefined,
        expiresAt: expiresAt !== undefined ? (expiresAt ? new Date(expiresAt) : null) : undefined,
        type: type ?? undefined,
        grantTier: grantTier ?? undefined,
        grantDurationDays: grantDurationDays ?? undefined,
        maxUses: maxUses ?? undefined
      }
    });
    
    res.json({ code });
  } catch (error: any) {
    console.error('Update referral code error:', error);
    res.status(500).json({ error: 'Failed to update referral code' });
  }
});

router.delete('/referral-codes/:id', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    await prisma.referralCode.delete({
      where: { id }
    });
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('Delete referral code error:', error);
    res.status(500).json({ error: 'Failed to delete referral code' });
  }
});

router.get('/referral-codes/:code/users', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { code } = req.params;
    
    const users = await prisma.user.findMany({
      where: { referralCode: code.toUpperCase() },
      select: {
        id: true,
        name: true,
        email: true,
        subscriptionStatus: true,
        isPro: true,
        createdAt: true,
        subscriptions: {
          where: { source: 'ENTERPRISE' },
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json({ users });
  } catch (error: any) {
    console.error('Get referral users error:', error);
    res.status(500).json({ error: 'Failed to get referral users' });
  }
});

// ============ ENTERPRISE SUBSCRIPTIONS ============

router.get('/subscriptions', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { source, status } = req.query;
    
    const where: any = {};
    if (source) where.source = source;
    if (status) where.status = status;
    
    const subscriptions = await prisma.subscription.findMany({
      where,
      include: {
        user: {
          select: { id: true, name: true, email: true, isPro: true }
        },
        referralCode: {
          select: { code: true, description: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const now = new Date();
    const expiringSoon = subscriptions.filter(s => 
      s.status === 'ACTIVE' && 
      s.endsAt && 
      s.endsAt.getTime() - now.getTime() < 7 * 24 * 60 * 60 * 1000
    );
    
    res.json({
      subscriptions,
      summary: {
        total: subscriptions.length,
        active: subscriptions.filter(s => s.status === 'ACTIVE').length,
        expiringSoon: expiringSoon.length,
        bySource: subscriptions.reduce<Record<string, number>>((acc, s) => {
          acc[s.source] = (acc[s.source] || 0) + 1;
          return acc;
        }, {})
      }
    });
  } catch (error: any) {
    console.error('List subscriptions error:', error);
    res.status(500).json({ error: 'Failed to list subscriptions' });
  }
});

router.post('/subscriptions', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { userId, tier, durationDays, notes } = req.body;
    
    if (!userId || !durationDays) {
      return res.status(400).json({ error: 'userId and durationDays are required' });
    }
    
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const now = new Date();
    const endsAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
    
    const [subscription] = await prisma.$transaction([
      prisma.subscription.create({
        data: {
          userId,
          source: 'ENTERPRISE',
          tier: tier || 'PRO',
          status: 'ACTIVE',
          startsAt: now,
          endsAt,
          activatedBy: 'super_admin',
          notes: notes || null
        }
      }),
      prisma.user.update({
        where: { id: userId },
        data: { 
          isPro: true,
          subscriptionStatus: 'ACTIVE'
        }
      })
    ]);
    
    console.log(`[Super Admin] Created enterprise subscription for ${user.email} (${durationDays} days)`);
    
    res.json({ subscription });
  } catch (error: any) {
    console.error('Create subscription error:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

router.patch('/subscriptions/:id/revoke', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    const subscription = await prisma.subscription.findUnique({
      where: { id },
      include: { user: true }
    });
    
    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    
    const activeSubscriptions = await prisma.subscription.count({
      where: {
        userId: subscription.userId,
        status: 'ACTIVE',
        id: { not: id }
      }
    });
    
    await prisma.$transaction([
      prisma.subscription.update({
        where: { id },
        data: { status: 'CANCELED' }
      }),
      ...(activeSubscriptions === 0 ? [
        prisma.user.update({
          where: { id: subscription.userId },
          data: { 
            isPro: false,
            subscriptionStatus: 'CANCELED'
          }
        })
      ] : [])
    ]);
    
    console.log(`[Super Admin] Revoked enterprise subscription for ${subscription.user.email}`);
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('Revoke subscription error:', error);
    res.status(500).json({ error: 'Failed to revoke subscription' });
  }
});

router.patch('/subscriptions/:id/extend', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { additionalDays } = req.body;
    
    if (!additionalDays || additionalDays <= 0) {
      return res.status(400).json({ error: 'additionalDays must be a positive number' });
    }
    
    const subscription = await prisma.subscription.findUnique({
      where: { id },
      include: { user: true }
    });
    
    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    
    const currentEnd = subscription.endsAt || new Date();
    const newEndsAt = new Date(currentEnd.getTime() + additionalDays * 24 * 60 * 60 * 1000);
    
    const updated = await prisma.subscription.update({
      where: { id },
      data: { 
        endsAt: newEndsAt,
        status: 'ACTIVE'
      }
    });
    
    await prisma.user.update({
      where: { id: subscription.userId },
      data: { isPro: true, subscriptionStatus: 'ACTIVE' }
    });
    
    console.log(`[Super Admin] Extended enterprise subscription for ${subscription.user.email} by ${additionalDays} days`);
    
    res.json({ subscription: updated });
  } catch (error: any) {
    console.error('Extend subscription error:', error);
    res.status(500).json({ error: 'Failed to extend subscription' });
  }
});

// ============ SYSTEM EVENTS / DEV CONSOLE ============

router.get('/events', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { 
      limit = '100',
      offset = '0',
      severity,
      eventType,
      source,
      businessId,
      userId,
      since
    } = req.query;

    const where: any = {};

    if (severity) {
      where.severity = severity;
    }
    if (eventType) {
      where.eventType = eventType;
    }
    if (source) {
      where.source = { contains: source as string };
    }
    if (businessId) {
      where.businessId = businessId;
    }
    if (userId) {
      where.userId = userId;
    }
    if (since) {
      where.createdAt = { gte: new Date(since as string) };
    }

    const [events, total] = await Promise.all([
      prisma.systemEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit as string),
        skip: parseInt(offset as string)
      }),
      prisma.systemEvent.count({ where })
    ]);

    res.json({ events, total });
  } catch (error: any) {
    console.error('Get events error:', error);
    res.status(500).json({ error: 'Failed to get events' });
  }
});

router.get('/events/stats', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const lastHour = new Date(now.getTime() - 60 * 60 * 1000);
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      totalToday,
      totalLastHour,
      byTypeToday,
      bySeverityToday,
      errorStats,
      recentErrors
    ] = await Promise.all([
      prisma.systemEvent.count({ where: { createdAt: { gte: today } } }),
      prisma.systemEvent.count({ where: { createdAt: { gte: lastHour } } }),
      prisma.systemEvent.groupBy({
        by: ['eventType'],
        where: { createdAt: { gte: today } },
        _count: true,
        orderBy: { _count: { eventType: 'desc' } },
        take: 10
      }),
      prisma.systemEvent.groupBy({
        by: ['severity'],
        where: { createdAt: { gte: today } },
        _count: true
      }),
      prisma.systemEvent.count({
        where: {
          severity: { in: ['ERROR', 'CRITICAL'] },
          createdAt: { gte: last24h }
        }
      }),
      prisma.systemEvent.findMany({
        where: { severity: { in: ['ERROR', 'CRITICAL'] } },
        orderBy: { createdAt: 'desc' },
        take: 10
      })
    ]);

    const severityMap = bySeverityToday.reduce<Record<string, number>>((acc, s) => {
      acc[s.severity] = s._count;
      return acc;
    }, {});

    res.json({
      counts: {
        today: totalToday,
        lastHour: totalLastHour,
        errors24h: errorStats
      },
      byType: byTypeToday.map(t => ({ type: t.eventType, count: t._count })),
      bySeverity: severityMap,
      recentErrors
    });
  } catch (error: any) {
    console.error('Get event stats error:', error);
    res.status(500).json({ error: 'Failed to get event stats' });
  }
});

router.get('/events/sources', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const sources = await prisma.systemEvent.groupBy({
      by: ['source'],
      _count: true,
      orderBy: { _count: { source: 'desc' } }
    });

    res.json({ sources: sources.map(s => ({ source: s.source, count: s._count })) });
  } catch (error: any) {
    console.error('Get sources error:', error);
    res.status(500).json({ error: 'Failed to get sources' });
  }
});

router.delete('/events/cleanup', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const { olderThanDays = '30' } = req.query;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - parseInt(olderThanDays as string));

    const result = await prisma.systemEvent.deleteMany({
      where: { createdAt: { lt: cutoffDate } }
    });

    res.json({ deleted: result.count });
  } catch (error: any) {
    console.error('Cleanup events error:', error);
    res.status(500).json({ error: 'Failed to cleanup events' });
  }
});

// ============ COMMAND CENTER ============

router.get('/command-center', superAdminMiddleware, async (req: SuperAdminRequest, res: Response) => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      activeUsers,
      newUsersToday,
      activeInstances,
      messagesToday,
      ordersToday,
      revenueToday,
      tokenCostToday,
      errorCount24h,
      pendingReminders,
      recentActivity
    ] = await Promise.all([
      prisma.user.count({ where: { subscriptionStatus: { in: ['TRIAL', 'ACTIVE'] } } }),
      prisma.user.count({ where: { createdAt: { gte: today } } }),
      prisma.whatsAppInstance.count({ where: { status: 'open' } }),
      prisma.messageLog.count({ where: { createdAt: { gte: today } } }),
      prisma.order.count({ where: { createdAt: { gte: today } } }),
      prisma.order.aggregate({
        where: { 
          status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] },
          createdAt: { gte: today } 
        },
        _sum: { totalAmount: true }
      }),
      prisma.tokenUsage.aggregate({
        where: { createdAt: { gte: today } },
        _sum: { costUsd: true }
      }),
      prisma.systemEvent.count({
        where: { severity: { in: ['ERROR', 'CRITICAL'] }, createdAt: { gte: last24h } }
      }),
      prisma.reminder.count({ where: { status: 'pending' } }),
      prisma.systemEvent.findMany({
        where: { severity: { in: ['INFO', 'WARNING', 'ERROR', 'CRITICAL'] } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          eventType: true,
          severity: true,
          source: true,
          message: true,
          createdAt: true
        }
      })
    ]);

    res.json({
      health: {
        status: errorCount24h > 10 ? 'degraded' : errorCount24h > 0 ? 'warning' : 'healthy',
        errors24h: errorCount24h
      },
      users: {
        active: activeUsers,
        newToday: newUsersToday
      },
      whatsapp: {
        connectedInstances: activeInstances
      },
      activity: {
        messagesToday,
        ordersToday,
        revenueToday: revenueToday._sum.totalAmount || 0,
        tokenCostToday: tokenCostToday._sum.costUsd || 0
      },
      pending: {
        reminders: pendingReminders
      },
      recentActivity
    });
  } catch (error: any) {
    console.error('Command center error:', error);
    res.status(500).json({ error: 'Failed to get command center data' });
  }
});

export default router;

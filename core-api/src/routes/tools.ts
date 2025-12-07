import { Router, Response } from 'express';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);

async function checkBusinessAccess(userId: string, businessId: string) {
  return prisma.business.findFirst({ where: { id: businessId, userId } });
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { business_id } = req.query;
    
    if (!business_id) {
      return res.status(400).json({ error: 'business_id is required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, business_id as string);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const prompt = await prisma.agentPrompt.findUnique({
      where: { businessId: business_id as string },
      include: { tools: true }
    });
    
    res.json(prompt?.tools || []);
  } catch (error) {
    console.error('Get tools error:', error);
    res.status(500).json({ error: 'Failed to get tools' });
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, name, description, url, method, headers, bodyTemplate, parameters } = req.body;
    
    if (!business_id || !name || !description || !url) {
      return res.status(400).json({ error: 'business_id, name, description, and url are required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, business_id);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    let prompt = await prisma.agentPrompt.findUnique({
      where: { businessId: business_id }
    });
    
    if (!prompt) {
      prompt = await prisma.agentPrompt.create({
        data: {
          businessId: business_id,
          prompt: 'Eres un asistente de atención al cliente amable y profesional.'
        }
      });
    }
    
    const tool = await prisma.agentTool.create({
      data: {
        promptId: prompt.id,
        name,
        description,
        url,
        method: method || 'POST',
        headers: headers || null,
        bodyTemplate: bodyTemplate || null,
        parameters: parameters || null
      }
    });
    
    res.status(201).json(tool);
  } catch (error) {
    console.error('Create tool error:', error);
    res.status(500).json({ error: 'Failed to create tool' });
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, url, method, headers, bodyTemplate, parameters, enabled } = req.body;
    
    const existing = await prisma.agentTool.findUnique({
      where: { id: req.params.id },
      include: { prompt: { include: { business: { select: { userId: true } } } } }
    });
    
    if (!existing || existing.prompt.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    
    const tool = await prisma.agentTool.update({
      where: { id: req.params.id },
      data: {
        name: name ?? existing.name,
        description: description ?? existing.description,
        url: url ?? existing.url,
        method: method ?? existing.method,
        headers: headers !== undefined ? headers : existing.headers,
        bodyTemplate: bodyTemplate !== undefined ? bodyTemplate : existing.bodyTemplate,
        parameters: parameters !== undefined ? parameters : existing.parameters,
        enabled: enabled !== undefined ? enabled : existing.enabled
      }
    });
    
    res.json(tool);
  } catch (error) {
    console.error('Update tool error:', error);
    res.status(500).json({ error: 'Failed to update tool' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.agentTool.findUnique({
      where: { id: req.params.id },
      include: { prompt: { include: { business: { select: { userId: true } } } } }
    });
    
    if (!existing || existing.prompt.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    
    await prisma.agentTool.delete({
      where: { id: req.params.id }
    });
    
    res.json({ deleted: true });
  } catch (error) {
    console.error('Delete tool error:', error);
    res.status(500).json({ error: 'Failed to delete tool' });
  }
});

router.post('/:id/test', async (req: AuthRequest, res: Response) => {
  try {
    const { testPayload } = req.body;
    
    const tool = await prisma.agentTool.findUnique({
      where: { id: req.params.id },
      include: { prompt: { include: { business: { select: { userId: true } } } } }
    });
    
    if (!tool || tool.prompt.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    
    const response = await fetch(tool.url, {
      method: tool.method,
      headers: {
        'Content-Type': 'application/json',
        ...(tool.headers as Record<string, string> || {})
      },
      body: JSON.stringify(testPayload || {})
    });
    
    const data = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = data;
    }
    
    res.json({
      status: response.status,
      statusText: response.statusText,
      data: parsed
    });
  } catch (error: any) {
    console.error('Test tool error:', error);
    res.status(500).json({ error: error.message || 'Failed to test tool' });
  }
});

router.get('/:id/logs', async (req: AuthRequest, res: Response) => {
  try {
    const { limit = '50', offset = '0' } = req.query;
    
    const tool = await prisma.agentTool.findUnique({
      where: { id: req.params.id },
      include: { prompt: { include: { business: { select: { userId: true } } } } }
    });
    
    if (!tool || tool.prompt.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    
    const [logs, total] = await Promise.all([
      prisma.toolLog.findMany({
        where: { toolId: req.params.id },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit as string),
        skip: parseInt(offset as string)
      }),
      prisma.toolLog.count({
        where: { toolId: req.params.id }
      })
    ]);
    
    res.json({
      logs,
      total,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string)
    });
  } catch (error) {
    console.error('Get tool logs error:', error);
    res.status(500).json({ error: 'Failed to get tool logs' });
  }
});

router.get('/:id/stats', async (req: AuthRequest, res: Response) => {
  try {
    const tool = await prisma.agentTool.findUnique({
      where: { id: req.params.id },
      include: { prompt: { include: { business: { select: { userId: true } } } } }
    });
    
    if (!tool || tool.prompt.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    
    const [totalCalls, avgDuration, lastCall] = await Promise.all([
      prisma.toolLog.count({ where: { toolId: req.params.id } }),
      prisma.toolLog.aggregate({
        where: { toolId: req.params.id },
        _avg: { duration: true }
      }),
      prisma.toolLog.findFirst({
        where: { toolId: req.params.id },
        orderBy: { createdAt: 'desc' }
      })
    ]);
    
    res.json({
      totalCalls,
      avgDuration: Math.round(avgDuration._avg.duration || 0),
      lastCall: lastCall?.createdAt || null
    });
  } catch (error) {
    console.error('Get tool stats error:', error);
    res.status(500).json({ error: 'Failed to get tool stats' });
  }
});

export default router;

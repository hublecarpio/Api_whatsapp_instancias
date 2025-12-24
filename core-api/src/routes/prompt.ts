import { Router, Response } from 'express';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);

async function checkBusinessAccess(userId: string, businessId: string) {
  return prisma.business.findFirst({ where: { id: businessId, userId } });
}

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, instanceId, prompt, bufferSeconds, historyLimit, splitMessages } = req.body;
    
    if (!businessId || !prompt) {
      return res.status(400).json({ error: 'businessId and prompt are required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    let existing;
    if (instanceId) {
      existing = await prisma.agentPrompt.findUnique({ where: { instanceId } });
    } else {
      existing = await prisma.agentPrompt.findFirst({ where: { businessId, instanceId: null } });
    }
    
    const data: any = { prompt, updatedAt: new Date() };
    if (bufferSeconds !== undefined) data.bufferSeconds = bufferSeconds;
    if (historyLimit !== undefined) data.historyLimit = historyLimit;
    if (splitMessages !== undefined) data.splitMessages = splitMessages;
    
    let agentPrompt;
    if (existing) {
      agentPrompt = await prisma.agentPrompt.update({
        where: { id: existing.id },
        data,
        include: { tools: true }
      });
    } else {
      agentPrompt = await prisma.agentPrompt.create({
        data: { businessId, instanceId: instanceId || undefined, ...data },
        include: { tools: true }
      });
    }
    
    res.status(existing ? 200 : 201).json(agentPrompt);
  } catch (error) {
    console.error('Save prompt error:', error);
    res.status(500).json({ error: 'Failed to save prompt' });
  }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, instance_id } = req.query;
    
    if (!business_id) {
      return res.status(400).json({ error: 'business_id query param is required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, business_id as string);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    let prompt;
    if (instance_id) {
      prompt = await prisma.agentPrompt.findUnique({
        where: { instanceId: instance_id as string },
        include: { tools: true }
      });
    }
    
    if (!prompt) {
      prompt = await prisma.agentPrompt.findFirst({
        where: { businessId: business_id as string, instanceId: null },
        include: { tools: true }
      });
    }
    
    res.json(prompt || null);
  } catch (error) {
    console.error('Get prompt error:', error);
    res.status(500).json({ error: 'Failed to get prompt' });
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { prompt, bufferSeconds, historyLimit, splitMessages } = req.body;
    
    const existing = await prisma.agentPrompt.findUnique({
      where: { id: req.params.id },
      include: { business: { select: { userId: true } } }
    });
    
    if (!existing || existing.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Prompt not found' });
    }
    
    const data: any = { updatedAt: new Date() };
    if (prompt !== undefined) data.prompt = prompt;
    if (bufferSeconds !== undefined) data.bufferSeconds = bufferSeconds;
    if (historyLimit !== undefined) data.historyLimit = historyLimit;
    if (splitMessages !== undefined) data.splitMessages = splitMessages;
    
    const agentPrompt = await prisma.agentPrompt.update({
      where: { id: req.params.id },
      data,
      include: { tools: true }
    });
    
    res.json(agentPrompt);
  } catch (error) {
    console.error('Update prompt error:', error);
    res.status(500).json({ error: 'Failed to update prompt' });
  }
});

export default router;

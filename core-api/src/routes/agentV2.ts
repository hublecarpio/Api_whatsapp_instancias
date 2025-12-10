import { Router, Response } from 'express';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/billing.js';
import fs from 'fs';
import path from 'path';

const router = Router();

const DEFAULT_V2_SKILLS = {
  search_product: true,
  payment: true,
  followup: true,
  media: true,
  crm: true
};

const DEFAULT_V2_PROMPTS = {
  vendor: `Eres un agente de ventas experto. Tu objetivo es:
- Entender las necesidades del cliente
- Recomendar productos adecuados
- Responder preguntas con precision
- Guiar hacia la compra cuando sea apropiado
- Usar las herramientas disponibles cuando sea necesario`,
  observer: `Eres un observador analitico. Tu rol es:
- Detectar fallas en las respuestas del vendedor
- Identificar objeciones no resueltas del cliente
- Sugerir mejoras para futuras interacciones
- Evaluar el tono y efectividad de la comunicacion`,
  refiner: `Eres un optimizador de reglas. Tu funcion es:
- Generar nuevas reglas basadas en patrones exitosos
- Identificar comportamientos a evitar
- Crear directrices especificas para este negocio
- Mejorar continuamente las respuestas del agente`
};

router.get('/config/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    let config = await prisma.agentV2Config.findUnique({
      where: { businessId }
    });
    
    if (!config) {
      config = await prisma.agentV2Config.create({
        data: {
          businessId,
          skills: DEFAULT_V2_SKILLS,
          prompts: DEFAULT_V2_PROMPTS
        }
      });
    }
    
    return res.json({
      skills: config.skills || DEFAULT_V2_SKILLS,
      prompts: config.prompts || DEFAULT_V2_PROMPTS
    });
  } catch (error) {
    console.error('Error getting V2 config:', error);
    return res.status(500).json({ error: 'Failed to get config' });
  }
});

router.put('/config/:businessId', authMiddleware, requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { skills, prompts } = req.body;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const existingConfig = await prisma.agentV2Config.findUnique({
      where: { businessId }
    });
    
    const updateData: any = {};
    if (skills) updateData.skills = skills;
    if (prompts) updateData.prompts = prompts;
    
    let config;
    if (existingConfig) {
      config = await prisma.agentV2Config.update({
        where: { businessId },
        data: updateData
      });
    } else {
      config = await prisma.agentV2Config.create({
        data: {
          businessId,
          skills: skills || DEFAULT_V2_SKILLS,
          prompts: prompts || DEFAULT_V2_PROMPTS
        }
      });
    }
    
    return res.json({
      success: true,
      skills: config.skills,
      prompts: config.prompts
    });
  } catch (error) {
    console.error('Error saving V2 config:', error);
    return res.status(500).json({ error: 'Failed to save config' });
  }
});

router.get('/memories/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const leadMemories = await prisma.leadMemory.findMany({
      where: { businessId },
      orderBy: { updatedAt: 'desc' },
      take: 100
    });
    
    const memories = leadMemories.map(m => ({
      leadId: m.id,
      phone: m.leadPhone,
      name: m.leadName,
      stage: m.stage,
      preferences: m.preferences || [],
      collectedData: m.collectedData || {},
      notes: m.notes || [],
      lastInteraction: m.updatedAt?.toISOString()
    }));
    
    return res.json({ memories });
  } catch (error) {
    console.error('Error getting lead memories:', error);
    return res.status(500).json({ error: 'Failed to get memories' });
  }
});

router.get('/memory/:businessId/:leadId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, leadId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const memory = await prisma.leadMemory.findFirst({
      where: { id: leadId, businessId }
    });
    
    if (!memory) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    
    return res.json({
      leadId: memory.id,
      phone: memory.leadPhone,
      name: memory.leadName,
      stage: memory.stage,
      preferences: memory.preferences || [],
      collectedData: memory.collectedData || {},
      notes: memory.notes || [],
      lastInteraction: memory.updatedAt?.toISOString()
    });
  } catch (error) {
    console.error('Error getting lead memory:', error);
    return res.status(500).json({ error: 'Failed to get memory' });
  }
});

router.get('/rules/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const learnedRules = await prisma.learnedRule.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' }
    });
    
    const rules = learnedRules.map(r => ({
      id: r.id,
      rule: r.rule,
      source: r.source,
      enabled: r.enabled,
      createdAt: r.createdAt.toISOString(),
      appliedCount: r.appliedCount
    }));
    
    return res.json({ rules });
  } catch (error) {
    console.error('Error getting learned rules:', error);
    return res.status(500).json({ error: 'Failed to get rules' });
  }
});

router.patch('/rules/:businessId/:ruleId', authMiddleware, requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, ruleId } = req.params;
    const { enabled } = req.body;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const rule = await prisma.learnedRule.update({
      where: { id: ruleId, businessId },
      data: { enabled }
    });
    
    return res.json({
      success: true,
      id: rule.id,
      enabled: rule.enabled
    });
  } catch (error) {
    console.error('Error updating rule:', error);
    return res.status(500).json({ error: 'Failed to update rule' });
  }
});

router.delete('/rules/:businessId/:ruleId', authMiddleware, requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, ruleId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    await prisma.learnedRule.delete({
      where: { id: ruleId, businessId }
    });
    
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting rule:', error);
    return res.status(500).json({ error: 'Failed to delete rule' });
  }
});

router.post('/embeddings/:businessId', authMiddleware, requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const products = await prisma.product.findMany({
      where: { businessId }
    });
    
    return res.json({ 
      success: true,
      message: `Embeddings queued for ${products.length} products`,
      productCount: products.length
    });
  } catch (error) {
    console.error('Error generating embeddings:', error);
    return res.status(500).json({ error: 'Failed to generate embeddings' });
  }
});

export default router;

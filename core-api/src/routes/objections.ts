import { Router, Response } from 'express';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/billing.js';

const router = Router();

router.get('/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const objections = await prisma.salesObjection.findMany({
      where: { businessId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }]
    });
    
    return res.json(objections);
  } catch (error) {
    console.error('Error getting objections:', error);
    return res.status(500).json({ error: 'Failed to get objections' });
  }
});

router.post('/:businessId', authMiddleware, requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { name, triggerPhrases, responseScript, priority, category } = req.body;
    
    if (!name || !responseScript) {
      return res.status(400).json({ error: 'name and responseScript are required' });
    }
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const objection = await prisma.salesObjection.create({
      data: {
        businessId,
        name,
        triggerPhrases: triggerPhrases || [],
        responseScript,
        priority: priority || 0,
        category: category || null
      }
    });
    
    return res.status(201).json(objection);
  } catch (error) {
    console.error('Error creating objection:', error);
    return res.status(500).json({ error: 'Failed to create objection' });
  }
});

router.put('/:businessId/:objectionId', authMiddleware, requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, objectionId } = req.params;
    const { name, triggerPhrases, responseScript, priority, category, isActive } = req.body;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const existing = await prisma.salesObjection.findFirst({
      where: { id: objectionId, businessId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Objection not found' });
    }
    
    const updated = await prisma.salesObjection.update({
      where: { id: objectionId },
      data: {
        ...(name !== undefined && { name }),
        ...(triggerPhrases !== undefined && { triggerPhrases }),
        ...(responseScript !== undefined && { responseScript }),
        ...(priority !== undefined && { priority }),
        ...(category !== undefined && { category }),
        ...(isActive !== undefined && { isActive })
      }
    });
    
    return res.json(updated);
  } catch (error) {
    console.error('Error updating objection:', error);
    return res.status(500).json({ error: 'Failed to update objection' });
  }
});

router.delete('/:businessId/:objectionId', authMiddleware, requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, objectionId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const existing = await prisma.salesObjection.findFirst({
      where: { id: objectionId, businessId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Objection not found' });
    }
    
    await prisma.salesObjection.delete({
      where: { id: objectionId }
    });
    
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting objection:', error);
    return res.status(500).json({ error: 'Failed to delete objection' });
  }
});

router.post('/:businessId/seed-defaults', authMiddleware, requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const existingCount = await prisma.salesObjection.count({
      where: { businessId }
    });
    
    if (existingCount > 0) {
      return res.status(400).json({ error: 'Business already has objections configured' });
    }
    
    const defaultObjections = business.businessObjective === 'APPOINTMENTS' 
      ? getAppointmentDefaultObjections()
      : getSalesDefaultObjections();
    
    const created = await prisma.salesObjection.createMany({
      data: defaultObjections.map((obj, idx) => ({
        businessId,
        name: obj.name,
        triggerPhrases: obj.triggerPhrases,
        responseScript: obj.responseScript,
        priority: defaultObjections.length - idx,
        category: obj.category
      }))
    });
    
    const objections = await prisma.salesObjection.findMany({
      where: { businessId },
      orderBy: { priority: 'desc' }
    });
    
    return res.status(201).json({
      success: true,
      created: created.count,
      objections
    });
  } catch (error) {
    console.error('Error seeding objections:', error);
    return res.status(500).json({ error: 'Failed to seed default objections' });
  }
});

function getSalesDefaultObjections() {
  return [
    {
      name: 'Precio muy alto',
      category: 'precio',
      triggerPhrases: ['muy caro', 'caro', 'precio alto', 'no me alcanza', 'fuera de mi presupuesto', 'mas barato'],
      responseScript: `Entiendo tu preocupación por el precio. Lo que ofrecemos incluye [mencionar valor agregado]. Además, tenemos opciones de pago flexibles. ¿Te gustaría conocer las facilidades de pago disponibles?`
    },
    {
      name: 'Lo voy a pensar',
      category: 'indecision',
      triggerPhrases: ['lo pienso', 'lo voy a pensar', 'dejame pensar', 'no estoy seguro', 'tengo que pensarlo'],
      responseScript: `Claro, es una decisión importante. Para ayudarte, ¿hay algo específico que te genere dudas o alguna información adicional que necesites?`
    },
    {
      name: 'Comparando opciones',
      category: 'competencia',
      triggerPhrases: ['estoy comparando', 'viendo otras opciones', 'vi algo similar', 'en otro lado', 'la competencia'],
      responseScript: `Excelente que estés evaluando opciones. Lo que nos diferencia es [mencionar diferenciador único]. ¿Qué criterios son más importantes para ti al decidir?`
    },
    {
      name: 'No tengo tiempo ahora',
      category: 'tiempo',
      triggerPhrases: ['no tengo tiempo', 'estoy ocupado', 'ahora no puedo', 'mas tarde', 'después'],
      responseScript: `Entiendo que estás ocupado. ¿Te parece si te envío un resumen de la información y me dices cuándo sería buen momento para continuar?`
    },
    {
      name: 'Necesito consultarlo',
      category: 'decision',
      triggerPhrases: ['consultar', 'hablar con mi', 'preguntarle a', 'no tomo la decision', 'mi esposo', 'mi jefe'],
      responseScript: `Por supuesto, es bueno tomar decisiones en conjunto. ¿Hay información específica que necesites para esa conversación? También puedo preparar un resumen que puedas compartir.`
    }
  ];
}

function getAppointmentDefaultObjections() {
  return [
    {
      name: 'No tengo tiempo',
      category: 'tiempo',
      triggerPhrases: ['no tengo tiempo', 'estoy muy ocupado', 'mi agenda está llena', 'sin tiempo'],
      responseScript: `Entiendo que tu tiempo es valioso. Tenemos horarios flexibles incluyendo [horarios especiales si aplica]. ¿Qué día y hora te funcionaría mejor?`
    },
    {
      name: 'Costo de la consulta',
      category: 'precio',
      triggerPhrases: ['cuánto cuesta', 'precio de la cita', 'muy caro', 'no me alcanza'],
      responseScript: `La consulta tiene un valor de [precio]. Esto incluye [mencionar lo que incluye]. ¿Te gustaría conocer las opciones de pago o programar una cita?`
    },
    {
      name: 'Lo voy a pensar',
      category: 'indecision',
      triggerPhrases: ['lo pienso', 'tengo que pensarlo', 'no estoy seguro', 'después te digo'],
      responseScript: `Claro, tómate tu tiempo. Para cuando estés listo, los horarios disponibles más próximos son [horarios]. ¿Hay algo que pueda aclarar para ayudarte a decidir?`
    },
    {
      name: 'Distancia/Ubicación',
      category: 'logistica',
      triggerPhrases: ['queda lejos', 'la ubicación', 'dónde queda', 'me queda difícil llegar'],
      responseScript: `Estamos ubicados en [dirección]. También ofrecemos [opciones virtuales si aplica]. ¿Te gustaría más información sobre cómo llegar o prefieres una consulta virtual?`
    }
  ];
}

export default router;

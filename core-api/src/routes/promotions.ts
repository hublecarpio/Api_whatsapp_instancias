import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import prisma from '../services/prisma.js';

const router = express.Router();
const db = prisma as any;

router.get('/', authMiddleware, async (req: any, res) => {
  try {
    const { businessId, instanceId, activeOnly } = req.query;

    if (!businessId) {
      return res.status(400).json({ error: 'businessId es requerido' });
    }

    const business = await prisma.business.findFirst({
      where: {
        id: businessId as string,
        userId: req.userId
      }
    });

    if (!business) {
      return res.status(403).json({ error: 'No tienes acceso a este negocio' });
    }

    const where: any = { businessId };
    if (instanceId) {
      where.OR = [{ instanceId }, { instanceId: null }];
    }
    if (activeOnly === 'true') {
      where.isActive = true;
    }

    const promotions = await db.promotion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { orders: true } }
      }
    });

    res.json(promotions);
  } catch (error: any) {
    console.error('[PROMOTIONS] Error listing:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', authMiddleware, async (req: any, res) => {
  try {
    const { id } = req.params;

    const promotion = await db.promotion.findUnique({
      where: { id },
      include: {
        orders: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            contactName: true,
            contactPhone: true,
            totalAmount: true,
            discountAmount: true,
            createdAt: true
          }
        },
        _count: { select: { orders: true } }
      }
    });

    if (!promotion) {
      return res.status(404).json({ error: 'Promoción no encontrada' });
    }

    const business = await prisma.business.findFirst({
      where: {
        id: promotion.businessId,
        userId: req.userId
      }
    });

    if (!business) {
      return res.status(403).json({ error: 'No tienes acceso a esta promoción' });
    }

    res.json(promotion);
  } catch (error: any) {
    console.error('[PROMOTIONS] Error getting:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', authMiddleware, async (req: any, res) => {
  try {
    const {
      businessId,
      instanceId,
      name,
      description,
      discountType,
      discountValue,
      giftItems,
      minPurchase,
      maxUses,
      validFrom,
      validUntil,
      keywords
    } = req.body;

    if (!businessId || !name) {
      return res.status(400).json({ error: 'businessId y name son requeridos' });
    }

    const business = await prisma.business.findFirst({
      where: {
        id: businessId,
        userId: req.userId
      }
    });

    if (!business) {
      return res.status(403).json({ error: 'No tienes acceso a este negocio' });
    }

    const promotion = await db.promotion.create({
      data: {
        businessId,
        instanceId: instanceId || null,
        name,
        description: description || null,
        discountType: discountType || 'PERCENTAGE',
        discountValue: discountValue || 0,
        giftItems: giftItems || null,
        minPurchase: minPurchase || null,
        maxUses: maxUses || null,
        validFrom: validFrom ? new Date(validFrom) : null,
        validUntil: validUntil ? new Date(validUntil) : null,
        keywords: keywords || []
      }
    });

    console.log(`[PROMOTIONS] Created: ${promotion.name} for business ${businessId}`);
    res.status(201).json(promotion);
  } catch (error: any) {
    console.error('[PROMOTIONS] Error creating:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', authMiddleware, async (req: any, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      discountType,
      discountValue,
      giftItems,
      minPurchase,
      maxUses,
      validFrom,
      validUntil,
      keywords,
      isActive
    } = req.body;

    const existing = await db.promotion.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Promoción no encontrada' });
    }

    const business = await prisma.business.findFirst({
      where: {
        id: existing.businessId,
        userId: req.userId
      }
    });

    if (!business) {
      return res.status(403).json({ error: 'No tienes acceso a esta promoción' });
    }

    const promotion = await db.promotion.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(discountType !== undefined && { discountType }),
        ...(discountValue !== undefined && { discountValue }),
        ...(giftItems !== undefined && { giftItems }),
        ...(minPurchase !== undefined && { minPurchase }),
        ...(maxUses !== undefined && { maxUses }),
        ...(validFrom !== undefined && { validFrom: validFrom ? new Date(validFrom) : null }),
        ...(validUntil !== undefined && { validUntil: validUntil ? new Date(validUntil) : null }),
        ...(keywords !== undefined && { keywords }),
        ...(isActive !== undefined && { isActive })
      }
    });

    console.log(`[PROMOTIONS] Updated: ${promotion.name}`);
    res.json(promotion);
  } catch (error: any) {
    console.error('[PROMOTIONS] Error updating:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authMiddleware, async (req: any, res) => {
  try {
    const { id } = req.params;

    const existing = await db.promotion.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Promoción no encontrada' });
    }

    const business = await prisma.business.findFirst({
      where: {
        id: existing.businessId,
        userId: req.userId
      }
    });

    if (!business) {
      return res.status(403).json({ error: 'No tienes acceso a esta promoción' });
    }

    await db.promotion.delete({ where: { id } });

    console.log(`[PROMOTIONS] Deleted: ${existing.name}`);
    res.json({ success: true, message: 'Promoción eliminada' });
  } catch (error: any) {
    console.error('[PROMOTIONS] Error deleting:', error);
    res.status(500).json({ error: error.message });
  }
});

export async function findMatchingPromotion(
  businessId: string,
  instanceId: string | null,
  conversationText: string
): Promise<{
  id: string;
  name: string;
  discountType: string;
  discountValue: number;
  giftItems: string | null;
} | null> {
  try {
    const promotions = await db.promotion.findMany({
      where: {
        businessId,
        isActive: true,
        OR: instanceId 
          ? [{ instanceId }, { instanceId: null }]
          : [{ instanceId: null }]
      }
    });

    if (promotions.length === 0) return null;

    const textLower = conversationText.toLowerCase();
    
    for (const promo of promotions) {
      const nameLower = promo.name.toLowerCase();
      if (textLower.includes(nameLower)) {
        return {
          id: promo.id,
          name: promo.name,
          discountType: promo.discountType,
          discountValue: promo.discountValue,
          giftItems: promo.giftItems
        };
      }
      
      for (const keyword of promo.keywords) {
        if (textLower.includes(keyword.toLowerCase())) {
          return {
            id: promo.id,
            name: promo.name,
            discountType: promo.discountType,
            discountValue: promo.discountValue,
            giftItems: promo.giftItems
          };
        }
      }
    }

    return null;
  } catch (error) {
    console.error('[PROMOTIONS] Error finding match:', error);
    return null;
  }
}

export function calculateDiscount(
  subtotal: number,
  discountType: string,
  discountValue: number
): number {
  if (discountType === 'PERCENTAGE') {
    return Math.round((subtotal * discountValue / 100) * 100) / 100;
  } else if (discountType === 'FIXED') {
    return Math.min(discountValue, subtotal);
  }
  return 0;
}

export default router;

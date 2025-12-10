import { Router, Response } from 'express';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);

async function checkBusinessAccess(userId: string, businessId: string) {
  const business = await prisma.business.findFirst({
    where: { id: businessId, userId }
  });
  return business;
}

router.post('/bulk', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, products } = req.body;
    
    if (!businessId || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'businessId and products array are required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const validProducts = products.filter((p: any) => p.title && p.price !== undefined);
    
    if (validProducts.length === 0) {
      return res.status(400).json({ error: 'No valid products found. Each product needs at least title and price.' });
    }
    
    const created = await prisma.product.createMany({
      data: validProducts.map((p: any) => ({
        businessId,
        title: String(p.title).trim(),
        description: p.description ? String(p.description).trim() : null,
        price: parseFloat(p.price),
        imageUrl: p.imageUrl ? String(p.imageUrl).trim() : null
      }))
    });
    
    res.status(201).json({ 
      success: true, 
      created: created.count,
      skipped: products.length - validProducts.length
    });
  } catch (error) {
    console.error('Bulk create products error:', error);
    res.status(500).json({ error: 'Failed to create products' });
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, title, description, price, imageUrl } = req.body;
    
    if (!businessId || !title || price === undefined) {
      return res.status(400).json({ error: 'businessId, title and price are required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const product = await prisma.product.create({
      data: { businessId, title, description, price, imageUrl }
    });
    
    res.status(201).json(product);
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { business_id } = req.query;
    
    if (!business_id) {
      return res.status(400).json({ error: 'business_id query param is required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, business_id as string);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const products = await prisma.product.findMany({
      where: { businessId: business_id as string },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json(products);
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Failed to get products' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { business: { select: { userId: true } } }
    });
    
    if (!product || product.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    res.json(product);
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Failed to get product' });
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { title, description, price, imageUrl } = req.body;
    
    const existing = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { business: { select: { userId: true } } }
    });
    
    if (!existing || existing.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: { 
        title: title ?? existing.title,
        description: description ?? existing.description,
        price: price ?? existing.price,
        imageUrl: imageUrl ?? existing.imageUrl
      }
    });
    
    res.json(product);
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { business: { select: { userId: true } } }
    });
    
    if (!existing || existing.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    await prisma.product.delete({ where: { id: req.params.id } });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

export default router;

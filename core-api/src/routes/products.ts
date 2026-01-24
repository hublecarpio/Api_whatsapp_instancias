import { Router, Response } from 'express';
import multer from 'multer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { searchProductsIntelligent, findBestProductMatch } from '../services/productSearch.js';

// S3/MinIO configuration for product images
let s3Client: S3Client | null = null;
let bucketName: string | null = null;
let publicBaseUrl: string | null = null;

function initializeS3() {
  if (s3Client) return true;
  
  const endpoint = process.env.MINIO_ENDPOINT;
  const accessKey = process.env.MINIO_ACCESS_KEY;
  const secretKey = process.env.MINIO_SECRET_KEY;
  const bucket = process.env.MINIO_BUCKET;

  if (!endpoint || !accessKey || !secretKey || !bucket) {
    return false;
  }

  s3Client = new S3Client({
    endpoint: endpoint,
    region: 'us-east-1',
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
    forcePathStyle: true,
  });

  bucketName = bucket;
  publicBaseUrl = process.env.MINIO_PUBLIC_URL || endpoint;
  return true;
}

function getExtension(mimetype: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  return map[mimetype] || '.jpg';
}

function normalizeProductName(name: string): string {
  const normalized = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/[^a-z0-9]+/g, '_') // Replace non-alphanumeric with underscores
    .replace(/^_+|_+$/g, '') // Trim underscores
    .substring(0, 50); // Limit length
  
  return normalized || 'producto'; // Fallback for non-Latin names
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB for product images
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imagenes'));
    }
  }
});

const router = Router();

router.use(authMiddleware);

async function checkBusinessAccess(userId: string, businessId: string) {
  const business = await prisma.business.findFirst({
    where: { id: businessId, userId }
  });
  return business;
}

// Upload product image with normalized filename based on product name
router.post('/upload-image', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, productName } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No se proporciono imagen' });
    }
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId es requerido' });
    }
    
    if (!productName || !productName.trim()) {
      return res.status(400).json({ error: 'productName es requerido para generar el nombre del archivo' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }
    
    if (!initializeS3()) {
      return res.status(500).json({ error: 'Almacenamiento de medios no configurado' });
    }
    
    const extension = getExtension(req.file.mimetype);
    const normalizedName = normalizeProductName(productName.trim());
    const timestamp = Date.now().toString(36); // Short timestamp to avoid collisions
    const fileName = `${normalizedName}_${timestamp}${extension}`;
    const objectPath = `products/${businessId}/${fileName}`;
    
    await s3Client!.send(new PutObjectCommand({
      Bucket: bucketName!,
      Key: objectPath,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      ACL: 'public-read',
    }));
    
    const publicUrl = `${publicBaseUrl}/${bucketName}/${objectPath}`;
    
    console.log(`[Products] Image uploaded: ${fileName} -> ${publicUrl}`);
    
    res.json({
      url: publicUrl,
      path: objectPath,
      fileName: fileName,
      normalizedName: normalizedName
    });
  } catch (error: any) {
    console.error('[Products] Image upload error:', error);
    res.status(500).json({ error: 'Error al subir imagen' });
  }
});

router.post('/search', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, instanceId, query, limit = 10, intelligent = true } = req.body;
    
    if (!businessId || !query) {
      return res.status(400).json({ error: 'businessId and query are required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    if (intelligent) {
      const result = await searchProductsIntelligent(businessId, query, Math.min(limit, 20), instanceId);
      
      res.json({
        products: result.products,
        exactMatch: result.exactMatch,
        bestMatch: result.bestMatch,
        currency: {
          code: business.currencyCode,
          symbol: business.currencySymbol
        }
      });
      return;
    }
    
    const searchTerms = query.toLowerCase().split(/\s+/).filter((t: string) => t.length > 2);
    
    const products = await prisma.product.findMany({
      where: {
        businessId,
        OR: searchTerms.length > 0 ? [
          { title: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
          { variation: { contains: query, mode: 'insensitive' } },
          ...searchTerms.map((term: string) => ({ title: { contains: term, mode: 'insensitive' as const } })),
          ...searchTerms.map((term: string) => ({ description: { contains: term, mode: 'insensitive' as const } })),
          ...searchTerms.map((term: string) => ({ variation: { contains: term, mode: 'insensitive' as const } }))
        ] : [
          { title: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
          { variation: { contains: query, mode: 'insensitive' } }
        ]
      },
      take: Math.min(limit, 20),
      orderBy: { createdAt: 'desc' }
    });
    
    res.json({
      products: products.map(p => ({
        id: p.id,
        title: p.title,
        description: p.description,
        price: p.price,
        stock: p.stock,
        imageUrl: p.imageUrl,
        available: p.stock > 0
      })),
      currency: {
        code: business.currencyCode,
        symbol: business.currencySymbol
      }
    });
  } catch (error) {
    console.error('Search products error:', error);
    res.status(500).json({ error: 'Failed to search products' });
  }
});

router.post('/find-best-match', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, instanceId, query } = req.body;
    
    if (!businessId || !query) {
      return res.status(400).json({ error: 'businessId and query are required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const bestMatch = await findBestProductMatch(businessId, query, instanceId);
    
    if (bestMatch) {
      res.json({
        found: true,
        product: bestMatch,
        currency: {
          code: business.currencyCode,
          symbol: business.currencySymbol
        }
      });
    } else {
      res.json({
        found: false,
        message: `No se encontró un producto que coincida con "${query}"`,
        suggestion: 'Intenta con otro nombre o verifica el catálogo'
      });
    }
  } catch (error) {
    console.error('Find best match error:', error);
    res.status(500).json({ error: 'Failed to find product' });
  }
});

router.post('/bulk', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, instanceId, products } = req.body;
    
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
        instanceId: instanceId || null,
        title: String(p.title).trim(),
        description: p.description ? String(p.description).trim() : null,
        variation: p.variation ? String(p.variation).trim() : null,
        price: parseFloat(p.price),
        stock: p.stock !== undefined ? parseInt(p.stock) : 0,
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
    const { businessId, instanceId, title, description, variation, price, stock, imageUrl } = req.body;
    
    if (!businessId || !title || price === undefined) {
      return res.status(400).json({ error: 'businessId, title and price are required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const product = await prisma.product.create({
      data: { 
        businessId, 
        instanceId: instanceId || null,
        title, 
        description,
        variation: variation || null,
        price, 
        stock: stock !== undefined ? parseInt(stock) : 0,
        imageUrl 
      }
    });
    
    res.status(201).json(product);
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Failed to create product' });
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
    
    const whereClause: any = { businessId: business_id as string };
    // Only filter by instanceId if a specific value is provided
    // If not provided, show ALL products for the business
    if (instance_id && String(instance_id).trim() !== '') {
      whereClause.instanceId = instance_id as string;
    }
    // Note: We no longer filter for null instanceId when not specified
    
    const products = await prisma.product.findMany({
      where: whereClause,
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
    const { title, description, variation, price, stock, imageUrl } = req.body;
    
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
        variation: variation !== undefined ? variation : existing.variation,
        price: price ?? existing.price,
        stock: stock !== undefined ? parseInt(stock) : existing.stock,
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

router.post('/bulk-delete', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, productIds } = req.body;
    
    if (!businessId || !Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: 'businessId and productIds array are required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const deleted = await prisma.product.deleteMany({
      where: {
        id: { in: productIds },
        businessId
      }
    });
    
    res.json({ success: true, deleted: deleted.count });
  } catch (error) {
    console.error('Bulk delete products error:', error);
    res.status(500).json({ error: 'Failed to delete products' });
  }
});

export default router;

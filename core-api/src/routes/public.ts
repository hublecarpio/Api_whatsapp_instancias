import { Router, Request, Response } from 'express';
import prisma from '../services/prisma';
import eventLogger from '../services/eventLogger';

const router = Router();

const PUBLIC_API_KEY = process.env.PUBLIC_INJECT_API_KEY || 'efficore-public-key-2024';

router.post('/inject-prompt', async (req: Request, res: Response) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== PUBLIC_API_KEY) {
      return res.status(401).json({ error: 'API key invalida' });
    }

    const {
      identificador,
      codigo_verificacion,
      nombre_negocio,
      rubro,
      producto_principal,
      objetivo_negocio,
      cliente_ideal,
      dolores_principales,
      objeciones_frecuentes,
      tono_agente,
      jergas,
      info_operativa,
      preguntas_frecuentes,
      enlaces_relevantes,
      prompt_comercial_final
    } = req.body;

    if (!identificador) {
      return res.status(400).json({ error: 'Se requiere el identificador (email)' });
    }

    if (!codigo_verificacion) {
      return res.status(400).json({ error: 'Se requiere el codigo_verificacion' });
    }

    if (!prompt_comercial_final) {
      return res.status(400).json({ error: 'Se requiere el prompt_comercial_final' });
    }

    const user = await prisma.user.findUnique({
      where: { email: identificador.toLowerCase() },
      include: { businesses: true }
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado con ese email' });
    }

    if (user.businesses.length === 0) {
      return res.status(404).json({ error: 'El usuario no tiene negocios registrados' });
    }

    const business = user.businesses.find(
      b => b.injectionCode && b.injectionCode === codigo_verificacion.toUpperCase()
    );

    if (!business) {
      return res.status(401).json({ error: 'Codigo de verificacion invalido' });
    }

    const businessContext = {
      producto_principal: producto_principal || null,
      objetivo_negocio: objetivo_negocio || null,
      cliente_ideal: cliente_ideal || null,
      dolores_principales: dolores_principales || null,
      objeciones_frecuentes: objeciones_frecuentes || null,
      tono_agente: tono_agente || null,
      jergas: jergas || [],
      info_operativa: info_operativa || null,
      preguntas_frecuentes: preguntas_frecuentes || [],
      enlaces_relevantes: enlaces_relevantes || [],
      lastUpdated: new Date().toISOString()
    };

    await prisma.business.update({
      where: { id: business.id },
      data: {
        name: nombre_negocio || business.name,
        industry: rubro || business.industry,
        businessContext
      }
    });

    let promptRecord = await prisma.agentPrompt.findFirst({
      where: { businessId: business.id }
    });

    if (promptRecord) {
      await prisma.agentPrompt.update({
        where: { id: promptRecord.id },
        data: {
          prompt: prompt_comercial_final,
          updatedAt: new Date()
        }
      });
    } else {
      await prisma.agentPrompt.create({
        data: {
          businessId: business.id,
          prompt: prompt_comercial_final
        }
      });
    }

    await eventLogger.info('PUBLIC_API', `Prompt inyectado para ${nombre_negocio || business.name}`, {
      businessId: business.id,
      userId: user.id,
      details: { identificador, nombre_negocio, rubro }
    });

    res.json({
      success: true,
      message: 'Prompt y datos del negocio actualizados correctamente',
      business: {
        id: business.id,
        name: nombre_negocio || business.name,
        industry: rubro || business.industry
      }
    });

  } catch (error: any) {
    console.error('Error injecting prompt:', error);
    await eventLogger.error('PUBLIC_API', `Error al inyectar prompt: ${error.message}`, {
      details: { error: error.message, body: req.body }
    });
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Queue diagnostics endpoint for debugging Redis/BullMQ issues
router.get('/queues/status', async (req: Request, res: Response) => {
  try {
    const { getQueuesStatus } = await import('../services/queues/index.js');
    const status = await getQueuesStatus();
    
    res.json({
      timestamp: new Date().toISOString(),
      ...status
    });
  } catch (error: any) {
    res.json({
      timestamp: new Date().toISOString(),
      redis: { connected: false, error: error.message },
      queues: {}
    });
  }
});

// Public catalog endpoint - no auth required
// Supports both instance-level and business-level catalogs
router.get('/catalog/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    
    if (!slug) {
      return res.status(400).json({ error: 'Se requiere el identificador del catálogo' });
    }

    const normalizedSlug = slug.toLowerCase();

    // First, try to find by WhatsApp instance slug (preferred - instance-specific catalog)
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { 
        slug: normalizedSlug,
        isActive: true
      },
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        catalogLogoUrl: true,
        business: {
          select: {
            id: true,
            name: true,
            description: true,
            logoUrl: true,
            industry: true,
            currencyCode: true,
            currencySymbol: true
          }
        },
        products: {
          select: {
            id: true,
            title: true,
            description: true,
            price: true,
            imageUrl: true,
            imageUrls: true,
            variations: true,
            pricePerVariation: true,
            stock: true,
            stockPerVariation: true
          },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (instance) {
      // Instance-level catalog found
      const whatsappPhone = instance.phoneNumber?.replace(/\D/g, '') || null;
      const logoUrl = instance.catalogLogoUrl || instance.business.logoUrl;

      return res.json({
        success: true,
        catalog: {
          businessName: instance.business.name,
          instanceName: instance.name,
          description: instance.business.description,
          logoUrl,
          industry: instance.business.industry,
          currencyCode: instance.business.currencyCode,
          currencySymbol: instance.business.currencySymbol,
          whatsappPhone,
          products: instance.products.map(product => {
            const variations = product.variations || [];
            const pricePerVariation = product.pricePerVariation || [];
            
            // Calculate minimum price for "desde" display
            let displayPrice = product.price;
            let hasVariablePricing = false;
            
            if (variations.length > 0 && pricePerVariation.length > 0) {
              const validPrices = pricePerVariation.filter(p => p > 0);
              if (validPrices.length > 0) {
                const minPrice = Math.min(...validPrices);
                const maxPrice = Math.max(...validPrices);
                hasVariablePricing = minPrice !== maxPrice;
                displayPrice = minPrice;
              }
            }
            
            return {
              id: product.id,
              title: product.title,
              description: product.description,
              price: product.price,
              displayPrice,
              hasVariablePricing,
              imageUrl: product.imageUrl || (product.imageUrls && product.imageUrls[0]) || null,
              imageUrls: product.imageUrls || [],
              variations,
              pricePerVariation,
              stock: product.stock,
              stockPerVariation: product.stockPerVariation || []
            };
          })
        }
      });
    }

    // Fallback: Try to find by business slug (legacy support)
    const business = await prisma.business.findFirst({
      where: { 
        slug: normalizedSlug
      },
      select: {
        id: true,
        name: true,
        description: true,
        logoUrl: true,
        industry: true,
        currencyCode: true,
        currencySymbol: true,
        instances: {
          where: { 
            isActive: true,
            phoneNumber: { not: null }
          },
          select: {
            id: true,
            phoneNumber: true,
            name: true
          },
          take: 1
        },
        products: {
          select: {
            id: true,
            title: true,
            description: true,
            price: true,
            imageUrl: true,
            imageUrls: true,
            variations: true,
            pricePerVariation: true,
            stock: true,
            stockPerVariation: true,
            instanceId: true
          },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!business) {
      return res.status(404).json({ error: 'Catálogo no encontrado' });
    }

    // Get the first active instance's phone number
    const primaryInstance = business.instances[0];
    const whatsappPhone = primaryInstance?.phoneNumber?.replace(/\D/g, '') || null;

    // Filter products by the primary instance ONLY (no shared products)
    let filteredProducts = business.products;
    if (primaryInstance) {
      filteredProducts = business.products.filter(
        p => p.instanceId === primaryInstance.id
      );
    } else {
      // If no instance, only show products without instance assignment
      filteredProducts = business.products.filter(p => p.instanceId === null);
    }

    res.json({
      success: true,
      catalog: {
        businessName: business.name,
        description: business.description,
        logoUrl: business.logoUrl,
        industry: business.industry,
        currencyCode: business.currencyCode,
        currencySymbol: business.currencySymbol,
        whatsappPhone,
        products: filteredProducts.map(product => {
          const variations = product.variations || [];
          const pricePerVariation = product.pricePerVariation || [];
          
          // Calculate minimum price for "desde" display
          let displayPrice = product.price;
          let hasVariablePricing = false;
          
          if (variations.length > 0 && pricePerVariation.length > 0) {
            const validPrices = pricePerVariation.filter(p => p > 0);
            if (validPrices.length > 0) {
              const minPrice = Math.min(...validPrices);
              const maxPrice = Math.max(...validPrices);
              hasVariablePricing = minPrice !== maxPrice;
              displayPrice = minPrice;
            }
          }
          
          return {
            id: product.id,
            title: product.title,
            description: product.description,
            price: product.price,
            displayPrice,
            hasVariablePricing,
            imageUrl: product.imageUrl || (product.imageUrls && product.imageUrls[0]) || null,
            imageUrls: product.imageUrls || [],
            variations,
            pricePerVariation,
            stock: product.stock,
            stockPerVariation: product.stockPerVariation || []
          };
        })
      }
    });

  } catch (error: any) {
    console.error('Error fetching public catalog:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.get('/ui-settings', async (req: Request, res: Response) => {
  try {
    const settings = await prisma.platformSettings.findUnique({
      where: { id: 'default' },
      select: { 
        glassMode: true,
        enableMetaCoexist: true,
        appName: true,
        appTagline: true,
        logoUrl: true,
        faviconUrl: true,
        primaryColor: true,
        secondaryColor: true,
        accentColor: true
      }
    });
    
    res.json({
      glassMode: settings?.glassMode ?? false,
      enableMetaCoexist: settings?.enableMetaCoexist ?? false,
      appName: settings?.appName ?? 'Effi',
      appTagline: settings?.appTagline ?? 'WhatsApp AI Platform',
      logoUrl: settings?.logoUrl ?? null,
      faviconUrl: settings?.faviconUrl ?? null,
      primaryColor: settings?.primaryColor ?? '#00D4FF',
      secondaryColor: settings?.secondaryColor ?? '#8B5CF6',
      accentColor: settings?.accentColor ?? '#10B981'
    });
  } catch (error: any) {
    console.error('Error fetching UI settings:', error);
    res.json({ 
      glassMode: false,
      enableMetaCoexist: false,
      appName: 'Effi',
      appTagline: 'WhatsApp AI Platform',
      logoUrl: null,
      faviconUrl: null,
      primaryColor: '#00D4FF',
      secondaryColor: '#8B5CF6',
      accentColor: '#10B981'
    });
  }
});

export default router;

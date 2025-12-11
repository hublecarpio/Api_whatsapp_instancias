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

    const business = user.businesses[0];

    if (!business.injectionCode || business.injectionCode !== codigo_verificacion.toUpperCase()) {
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

    let promptRecord = await prisma.agentPrompt.findUnique({
      where: { businessId: business.id }
    });

    if (promptRecord) {
      await prisma.agentPrompt.update({
        where: { businessId: business.id },
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

export default router;

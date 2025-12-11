import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import multer from 'multer';
import { uploadBuffer } from '../services/storage';

const router = Router();
const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(authMiddleware);

router.get('/:businessId', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const userId = req.userId;

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const prompt = await prisma.agentPrompt.findUnique({
      where: { businessId },
      include: {
        files: {
          orderBy: { order: 'asc' }
        }
      }
    });

    res.json({ files: prompt?.files || [] });
  } catch (error: any) {
    console.error('[AGENT_FILES] Error listing files:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:businessId', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const userId = req.userId;
    const { name, description, triggerKeywords, triggerContext, order } = req.body;

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    let prompt = await prisma.agentPrompt.findUnique({
      where: { businessId }
    });

    if (!prompt) {
      prompt = await prisma.agentPrompt.create({
        data: {
          businessId,
          prompt: 'Eres un asistente virtual profesional.'
        }
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No se subió ningún archivo' });
    }

    const ext = req.file.originalname.split('.').pop()?.toLowerCase() || 'bin';
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    const isDocument = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext);
    const fileType = isImage ? 'image' : isDocument ? 'document' : 'other';

    const uploadResult = await uploadBuffer(req.file.buffer, req.file.mimetype, businessId, req.file.originalname);
    
    if (!uploadResult) {
      return res.status(500).json({ error: 'Error al subir el archivo. Verifique la configuración de almacenamiento.' });
    }

    const fileUrl = uploadResult.url;

    const maxOrder = await prisma.agentFile.aggregate({
      where: { promptId: prompt.id },
      _max: { order: true }
    });

    const file = await prisma.agentFile.create({
      data: {
        promptId: prompt.id,
        name: name || req.file.originalname,
        description: description || null,
        fileUrl,
        fileType,
        triggerKeywords: triggerKeywords || null,
        triggerContext: triggerContext || null,
        order: order ? parseInt(order) : (maxOrder._max.order || 0) + 1
      }
    });

    res.json({ file });
  } catch (error: any) {
    console.error('[AGENT_FILES] Error creating file:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/:businessId/:fileId', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, fileId } = req.params;
    const userId = req.userId;
    const { name, description, triggerKeywords, triggerContext, order, enabled } = req.body;

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const prompt = await prisma.agentPrompt.findUnique({
      where: { businessId }
    });

    if (!prompt) {
      return res.status(404).json({ error: 'Configuración de agente no encontrada' });
    }

    const existingFile = await prisma.agentFile.findFirst({
      where: { id: fileId, promptId: prompt.id }
    });

    if (!existingFile) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }

    const file = await prisma.agentFile.update({
      where: { id: fileId },
      data: {
        name: name ?? existingFile.name,
        description: description ?? existingFile.description,
        triggerKeywords: triggerKeywords ?? existingFile.triggerKeywords,
        triggerContext: triggerContext ?? existingFile.triggerContext,
        order: order !== undefined ? parseInt(order) : existingFile.order,
        enabled: enabled !== undefined ? enabled : existingFile.enabled
      }
    });

    res.json({ file });
  } catch (error: any) {
    console.error('[AGENT_FILES] Error updating file:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:businessId/:fileId', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, fileId } = req.params;
    const userId = req.userId;

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const prompt = await prisma.agentPrompt.findUnique({
      where: { businessId }
    });

    if (!prompt) {
      return res.status(404).json({ error: 'Configuración de agente no encontrada' });
    }

    await prisma.agentFile.delete({
      where: { id: fileId }
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('[AGENT_FILES] Error deleting file:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/:businessId/reorder', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const userId = req.userId;
    const { fileOrders } = req.body;

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    if (!Array.isArray(fileOrders)) {
      return res.status(400).json({ error: 'fileOrders debe ser un array' });
    }

    await Promise.all(
      fileOrders.map(({ id, order }: { id: string; order: number }) =>
        prisma.agentFile.update({
          where: { id },
          data: { order }
        })
      )
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('[AGENT_FILES] Error reordering files:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

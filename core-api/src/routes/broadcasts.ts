import { Router, Response } from 'express';
import prisma from '../services/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import * as broadcastService from '../services/broadcastService';

const router = Router();

router.use(authMiddleware);

async function checkBusinessAccess(userId: string, businessId: string): Promise<boolean> {
  const business = await prisma.business.findFirst({
    where: { id: businessId, userId }
  });
  return !!business;
}

router.get('/:businessId', async (req: AuthRequest, res: Response) => {
  try {
    const hasAccess = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const campaigns = await (prisma as any).broadcastCampaign.findMany({
      where: { businessId: req.params.businessId },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    res.json(campaigns);
  } catch (error: any) {
    console.error('List broadcasts error:', error.message);
    res.status(500).json({ error: 'Failed to list broadcasts' });
  }
});

router.get('/:businessId/available-variables', async (req: AuthRequest, res: Response) => {
  try {
    const hasAccess = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const extractedDataFields = await prisma.contactExtractedData.findMany({
      where: { businessId: req.params.businessId },
      select: { fieldKey: true },
      distinct: ['fieldKey']
    });

    const fieldKeys = extractedDataFields.map((f: any) => f.fieldKey);
    
    const baseVariables = [
      { key: 'nombre', description: 'Nombre del contacto', example: '{{nombre}}' },
      { key: 'email', description: 'Email del contacto', example: '{{email}}' },
      { key: 'telefono', description: 'Telefono del contacto', example: '{{telefono}}' }
    ];
    
    const extractedVariables = fieldKeys.map((key: string) => ({
      key,
      description: `Campo extraido: ${key}`,
      example: `{{${key}}}`
    }));

    res.json({
      variables: [...baseVariables, ...extractedVariables],
      usage: 'Usa {{nombre_variable}} en tu mensaje para personalizar cada envio'
    });
  } catch (error: any) {
    console.error('Get available variables error:', error.message);
    res.status(500).json({ error: 'Failed to get available variables' });
  }
});

router.get('/:businessId/:campaignId', async (req: AuthRequest, res: Response) => {
  try {
    const hasAccess = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const stats = await broadcastService.getCampaignStats(req.params.campaignId);
    if (!stats) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    res.json(stats);
  } catch (error: any) {
    console.error('Get broadcast error:', error.message);
    res.status(500).json({ error: 'Failed to get broadcast' });
  }
});

router.get('/:businessId/:campaignId/logs', async (req: AuthRequest, res: Response) => {
  try {
    const hasAccess = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const status = req.query.status as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await broadcastService.getCampaignLogs(
      req.params.campaignId,
      status as any,
      limit,
      offset
    );

    res.json(result);
  } catch (error: any) {
    console.error('Get broadcast logs error:', error.message);
    res.status(500).json({ error: 'Failed to get broadcast logs' });
  }
});

router.post('/:businessId', async (req: AuthRequest, res: Response) => {
  try {
    const hasAccess = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const {
      name,
      messageType,
      content,
      mediaUrl,
      mediaCaption,
      fileName,
      templateId,
      templateParams,
      contactPhones,
      contactsWithVariables,
      delayMinSeconds,
      delayMaxSeconds,
      useCrmMetadata
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Campaign name is required' });
    }

    const hasContacts = (contactPhones && Array.isArray(contactPhones) && contactPhones.length > 0) ||
                        (contactsWithVariables && Array.isArray(contactsWithVariables) && contactsWithVariables.length > 0);
    
    if (!hasContacts) {
      return res.status(400).json({ error: 'At least one contact is required' });
    }

    if (messageType === 'TEXT' && !content) {
      return res.status(400).json({ error: 'Content is required for text messages' });
    }

    if (['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'].includes(messageType) && !mediaUrl) {
      return res.status(400).json({ error: 'Media URL is required for media messages' });
    }

    const finalContactsWithVars = contactsWithVariables || 
      (contactPhones ? contactPhones.map((phone: string) => ({ phone, variables: [] })) : []);

    const result = await broadcastService.createBroadcastCampaign({
      businessId: req.params.businessId,
      name,
      messageType: messageType || 'TEXT',
      content,
      mediaUrl,
      mediaCaption,
      fileName,
      templateId,
      templateParams,
      contactsWithVariables: finalContactsWithVars,
      delayMinSeconds: delayMinSeconds || 3,
      delayMaxSeconds: delayMaxSeconds || 10,
      createdBy: req.userId,
      useCrmMetadata: useCrmMetadata === true
    });

    res.status(201).json(result);
  } catch (error: any) {
    console.error('Create broadcast error:', error.message);
    res.status(500).json({ error: 'Failed to create broadcast' });
  }
});

router.post('/:businessId/:campaignId/start', async (req: AuthRequest, res: Response) => {
  try {
    const hasAccess = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    broadcastService.runBroadcastCampaign(req.params.campaignId).catch(err => {
      console.error(`[BROADCAST] Campaign ${req.params.campaignId} error:`, err);
    });

    res.json({ message: 'Broadcast started', campaignId: req.params.campaignId });
  } catch (error: any) {
    console.error('Start broadcast error:', error.message);
    res.status(500).json({ error: 'Failed to start broadcast' });
  }
});

router.post('/:businessId/:campaignId/pause', async (req: AuthRequest, res: Response) => {
  try {
    const hasAccess = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await broadcastService.pauseBroadcastCampaign(req.params.campaignId);
    res.json({ message: 'Broadcast paused' });
  } catch (error: any) {
    console.error('Pause broadcast error:', error.message);
    res.status(500).json({ error: 'Failed to pause broadcast' });
  }
});

router.post('/:businessId/:campaignId/resume', async (req: AuthRequest, res: Response) => {
  try {
    const hasAccess = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    broadcastService.resumeBroadcastCampaign(req.params.campaignId);
    res.json({ message: 'Broadcast resumed' });
  } catch (error: any) {
    console.error('Resume broadcast error:', error.message);
    res.status(500).json({ error: 'Failed to resume broadcast' });
  }
});

router.post('/:businessId/:campaignId/cancel', async (req: AuthRequest, res: Response) => {
  try {
    const hasAccess = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await broadcastService.cancelBroadcastCampaign(req.params.campaignId);
    res.json({ message: 'Broadcast cancelled' });
  } catch (error: any) {
    console.error('Cancel broadcast error:', error.message);
    res.status(500).json({ error: 'Failed to cancel broadcast' });
  }
});

router.delete('/:businessId/:campaignId', async (req: AuthRequest, res: Response) => {
  try {
    const hasAccess = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await (prisma as any).broadcastCampaign.delete({
      where: { id: req.params.campaignId }
    });

    res.json({ message: 'Broadcast deleted' });
  } catch (error: any) {
    console.error('Delete broadcast error:', error.message);
    res.status(500).json({ error: 'Failed to delete broadcast' });
  }
});

export default router;

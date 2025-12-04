import { Router, Request, Response } from 'express';
import { InstanceManager } from '../core/InstanceManager';
import { MediaStorage } from '../core/MediaStorage';
import { 
  CreateInstanceRequest, 
  SendMessageRequest, 
  SendImageRequest, 
  SendFileRequest,
  ApiResponse 
} from '../utils/types';
import logger from '../utils/logger';

const router = Router();

router.get('/media/:instanceId/:fileName', async (req: Request, res: Response) => {
  try {
    const { instanceId, fileName } = req.params;
    
    if (!MediaStorage.isEnabled()) {
      return res.status(503).json({
        success: false,
        error: 'Media storage not configured'
      } as ApiResponse);
    }

    const media = await MediaStorage.getMedia(instanceId, fileName);
    
    if (!media) {
      return res.status(404).json({
        success: false,
        error: 'Media not found'
      } as ApiResponse);
    }

    res.set({
      'Content-Type': media.mimetype,
      'Content-Length': media.buffer.length.toString(),
      'Cache-Control': 'public, max-age=31536000'
    });
    
    res.send(media.buffer);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to serve media');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

router.post('/instances', async (req: Request, res: Response) => {
  try {
    const { instanceId, webhook } = req.body as CreateInstanceRequest;

    if (!instanceId) {
      return res.status(400).json({
        success: false,
        error: 'instanceId is required'
      } as ApiResponse);
    }

    const existingInstance = InstanceManager.getInstance(instanceId);
    if (existingInstance) {
      return res.status(409).json({
        success: false,
        error: `Instance '${instanceId}' already exists`
      } as ApiResponse);
    }

    const instance = await InstanceManager.createInstance(instanceId, webhook || '');

    res.status(201).json({
      success: true,
      data: {
        instanceId: instance.id,
        status: instance.status,
        message: 'Instance created. Scan QR code to connect.'
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to create instance');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

router.get('/instances', async (req: Request, res: Response) => {
  try {
    const instances = InstanceManager.listInstances();
    
    res.json({
      success: true,
      data: {
        count: instances.length,
        instances
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to list instances');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

router.get('/instances/:id/qr', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const instance = InstanceManager.getInstance(id);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    if (instance.status === 'connected') {
      return res.json({
        success: true,
        data: {
          instanceId: id,
          status: 'connected',
          message: 'Instance already connected'
        }
      } as ApiResponse);
    }

    const qrCode = instance.getQRCode();

    if (!qrCode) {
      return res.json({
        success: true,
        data: {
          instanceId: id,
          status: instance.status,
          qrCode: null,
          message: 'QR code not yet available. Please wait.'
        }
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: {
        instanceId: id,
        status: instance.status,
        qrCode
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to get QR code');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

router.get('/instances/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const instance = InstanceManager.getInstance(id);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: {
        instanceId: id,
        status: instance.status,
        createdAt: instance.createdAt,
        lastConnection: instance.lastConnection
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to get instance status');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

router.post('/instances/:id/sendMessage', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { to, message } = req.body as SendMessageRequest;

    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: 'Both "to" and "message" are required'
      } as ApiResponse);
    }

    const instance = InstanceManager.getInstance(id);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    const result = await instance.sendText(to, message);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: {
        messageId: result.messageId,
        to,
        status: 'sent'
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to send message');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

router.post('/instances/:id/sendImage', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { to, url, caption } = req.body as SendImageRequest;

    if (!to || !url) {
      return res.status(400).json({
        success: false,
        error: 'Both "to" and "url" are required'
      } as ApiResponse);
    }

    const instance = InstanceManager.getInstance(id);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    const result = await instance.sendImage(to, url, caption);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: {
        messageId: result.messageId,
        to,
        status: 'sent'
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to send image');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

router.post('/instances/:id/sendFile', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { to, url, fileName, mimeType } = req.body as SendFileRequest;

    if (!to || !url || !fileName || !mimeType) {
      return res.status(400).json({
        success: false,
        error: '"to", "url", "fileName", and "mimeType" are all required'
      } as ApiResponse);
    }

    const instance = InstanceManager.getInstance(id);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    const result = await instance.sendFile(to, url, fileName, mimeType);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: {
        messageId: result.messageId,
        to,
        fileName,
        status: 'sent'
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to send file');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

// Send video with optional caption
router.post('/instances/:id/sendVideo', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { to, url, caption } = req.body;

    if (!to || !url) {
      return res.status(400).json({
        success: false,
        error: 'Both "to" and "url" are required'
      } as ApiResponse);
    }

    const instance = InstanceManager.getInstance(id);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    const result = await instance.sendVideo(to, url, caption);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: {
        messageId: result.messageId,
        to,
        status: 'sent'
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to send video');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

// Send audio/voice message (PTT = Push To Talk with waveform)
router.post('/instances/:id/sendAudio', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { to, url, ptt = true } = req.body;

    if (!to || !url) {
      return res.status(400).json({
        success: false,
        error: 'Both "to" and "url" are required'
      } as ApiResponse);
    }

    const instance = InstanceManager.getInstance(id);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    const result = await instance.sendAudio(to, url, ptt);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: {
        messageId: result.messageId,
        to,
        type: ptt ? 'ptt' : 'audio',
        status: 'sent'
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to send audio');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

// Send sticker
router.post('/instances/:id/sendSticker', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { to, url } = req.body;

    if (!to || !url) {
      return res.status(400).json({
        success: false,
        error: 'Both "to" and "url" are required'
      } as ApiResponse);
    }

    const instance = InstanceManager.getInstance(id);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    const result = await instance.sendSticker(to, url);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: {
        messageId: result.messageId,
        to,
        status: 'sent'
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to send sticker');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

// Send location
router.post('/instances/:id/sendLocation', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { to, latitude, longitude, name, address } = req.body;

    if (!to || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        error: '"to", "latitude", and "longitude" are required'
      } as ApiResponse);
    }

    const instance = InstanceManager.getInstance(id);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    const result = await instance.sendLocation(to, latitude, longitude, name, address);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: {
        messageId: result.messageId,
        to,
        status: 'sent'
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to send location');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

// Send contact
router.post('/instances/:id/sendContact', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { to, contactName, contactNumber } = req.body;

    if (!to || !contactName || !contactNumber) {
      return res.status(400).json({
        success: false,
        error: '"to", "contactName", and "contactNumber" are required'
      } as ApiResponse);
    }

    const instance = InstanceManager.getInstance(id);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    const result = await instance.sendContact(to, contactName, contactNumber);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: {
        messageId: result.messageId,
        to,
        status: 'sent'
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to send contact');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

router.post('/instances/:id/restart', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const instance = await InstanceManager.restartInstance(id);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: {
        instanceId: id,
        status: instance.status,
        message: 'Instance restarted successfully'
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to restart instance');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

router.delete('/instances/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const deleted = await InstanceManager.deleteInstance(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: {
        instanceId: id,
        message: 'Instance deleted successfully'
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to delete instance');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

// Send message to LID directly
router.post('/instances/:id/sendToLid', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { lid, message } = req.body;

    if (!lid || !message) {
      return res.status(400).json({
        success: false,
        error: 'Both "lid" and "message" are required'
      } as ApiResponse);
    }

    const instance = InstanceManager.getInstance(id);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    const result = await instance.sendToLid(lid, message);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: {
        messageId: result.messageId,
        lid,
        status: 'sent'
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to send message to LID');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

// Get LID to phone number mappings
router.get('/instances/:id/lid-mappings', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const instance = InstanceManager.getInstance(id);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    const mappings = instance.getLidMappings();
    const mappingsObject: Record<string, string> = {};
    mappings.forEach((phoneNumber, lid) => {
      mappingsObject[lid] = phoneNumber;
    });

    res.json({
      success: true,
      data: {
        instanceId: id,
        count: mappings.size,
        mappings: mappingsObject
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to get LID mappings');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

// Add LID to phone number mapping manually
router.post('/instances/:id/lid-mappings', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { lid, phoneNumber } = req.body;

    if (!lid || !phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'Both "lid" and "phoneNumber" are required'
      } as ApiResponse);
    }

    const instance = InstanceManager.getInstance(id);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: `Instance '${id}' not found`
      } as ApiResponse);
    }

    instance.addLidMapping(lid, phoneNumber);

    res.json({
      success: true,
      data: {
        instanceId: id,
        lid,
        phoneNumber,
        message: 'LID mapping added successfully'
      }
    } as ApiResponse);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to add LID mapping');
    res.status(500).json({
      success: false,
      error: error.message
    } as ApiResponse);
  }
});

export default router;

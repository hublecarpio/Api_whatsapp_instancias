import { Router, Request, Response } from 'express';
import prisma from '../services/prisma.js';
import { getMetaManagedService, findInstanceByManagedPhoneNumberId } from '../services/metaManaged.js';
import { authMiddleware } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

router.get('/status', authMiddleware as any, async (req: Request, res: Response) => {
  try {
    const service = getMetaManagedService();
    const isConfigured = service.isConfigured();

    res.json({
      configured: isConfigured,
      provider: 'META_MANAGED',
      description: 'Connect your phone number directly to our verified WhatsApp Business Account'
    });
  } catch (error: any) {
    console.error('[META_MANAGED] Status check error:', error);
    res.status(500).json({ error: 'Failed to check META_MANAGED status' });
  }
});

router.post('/register-number', authMiddleware as any, async (req: Request, res: Response) => {
  try {
    const { businessId, phoneNumber, verifiedName, codeMethod = 'SMS' } = req.body;
    const userId = (req as any).user?.id;

    if (!businessId || !phoneNumber) {
      return res.status(400).json({ error: 'businessId and phoneNumber are required' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId }
    });

    if (!business) {
      return res.status(403).json({ error: 'Business not found or access denied' });
    }

    const service = getMetaManagedService();
    if (!service.isConfigured()) {
      return res.status(503).json({ error: 'META_MANAGED provider is not configured on this platform' });
    }

    const cleanedPhone = phoneNumber.replace(/\D/g, '');
    const existingInstance = await prisma.whatsAppInstance.findFirst({
      where: {
        businessId,
        phoneNumber: { contains: cleanedPhone.slice(-9) },
        provider: 'META_MANAGED'
      }
    });

    if (existingInstance) {
      return res.status(409).json({ 
        error: 'This phone number is already registered',
        instanceId: existingInstance.id
      });
    }

    const result = await service.registerPhoneNumber({
      phoneNumber: cleanedPhone,
      verifiedName: verifiedName || business.name,
      codeMethod: codeMethod as 'SMS' | 'VOICE'
    });

    if (!result.success || !result.phoneNumberId) {
      return res.status(400).json({ error: result.error || 'Failed to register phone number' });
    }

    const existingInstances = await prisma.whatsAppInstance.count({
      where: { businessId }
    });

    const instance = await prisma.whatsAppInstance.create({
      data: {
        businessId,
        instanceNumber: existingInstances + 1,
        name: `WhatsApp ${existingInstances + 1}`,
        provider: 'META_MANAGED',
        phoneNumber: `+${cleanedPhone}`,
        status: 'pending_verification',
        isActive: false,
        botEnabled: true
      }
    });

    await prisma.metaManagedCredential.create({
      data: {
        instanceId: instance.id,
        phoneNumberId: result.phoneNumberId,
        displayPhone: `+${cleanedPhone}`,
        verifiedName: verifiedName || business.name,
        status: 'PENDING_VERIFICATION',
        registrationMethod: codeMethod
      }
    });

    await prisma.whatsAppInstanceHistory.create({
      data: {
        instanceId: instance.id,
        businessId,
        eventType: 'CREATED',
        newProvider: 'META_MANAGED',
        phoneNumber: `+${cleanedPhone}`,
        newStatus: 'pending_verification',
        details: 'Instance created via META_MANAGED, awaiting OTP verification'
      }
    });

    const codeResult = await service.requestVerificationCode(result.phoneNumberId, codeMethod as 'SMS' | 'VOICE');

    if (!codeResult.success) {
      console.warn('[META_MANAGED] Failed to request verification code:', codeResult.error);
    }

    res.json({
      success: true,
      instanceId: instance.id,
      phoneNumberId: result.phoneNumberId,
      status: 'pending_verification',
      message: `Verification code sent via ${codeMethod} to ${phoneNumber}`
    });
  } catch (error: any) {
    console.error('[META_MANAGED] Register number error:', error);
    res.status(500).json({ error: error.message || 'Failed to register phone number' });
  }
});

router.post('/resend-code', authMiddleware as any, async (req: Request, res: Response) => {
  try {
    const { instanceId, codeMethod = 'SMS' } = req.body;
    const userId = (req as any).user?.id;

    if (!instanceId) {
      return res.status(400).json({ error: 'instanceId is required' });
    }

    const instance = await prisma.whatsAppInstance.findFirst({
      where: {
        id: instanceId,
        provider: 'META_MANAGED',
        business: { userId }
      },
      include: {
        metaManagedCredential: true
      }
    });

    if (!instance || !instance.metaManagedCredential) {
      return res.status(404).json({ error: 'Instance not found or not a META_MANAGED instance' });
    }

    const credential = instance.metaManagedCredential;
    
    if (credential.status === 'ACTIVE') {
      return res.status(400).json({ error: 'Instance is already verified' });
    }

    if (credential.verificationAttempts >= 5) {
      return res.status(429).json({ error: 'Maximum verification attempts reached. Please contact support.' });
    }

    const service = getMetaManagedService();
    const result = await service.requestVerificationCode(credential.phoneNumberId, codeMethod as 'SMS' | 'VOICE');

    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Failed to resend verification code' });
    }

    await prisma.metaManagedCredential.update({
      where: { id: credential.id },
      data: {
        verificationAttempts: { increment: 1 },
        lastVerificationAt: new Date(),
        registrationMethod: codeMethod
      }
    });

    res.json({
      success: true,
      message: `Verification code resent via ${codeMethod}`,
      attemptsRemaining: 5 - credential.verificationAttempts - 1
    });
  } catch (error: any) {
    console.error('[META_MANAGED] Resend code error:', error);
    res.status(500).json({ error: error.message || 'Failed to resend verification code' });
  }
});

router.post('/verify', authMiddleware as any, async (req: Request, res: Response) => {
  try {
    const { instanceId, code } = req.body;
    const userId = (req as any).user?.id;

    if (!instanceId || !code) {
      return res.status(400).json({ error: 'instanceId and code are required' });
    }

    const instance = await prisma.whatsAppInstance.findFirst({
      where: {
        id: instanceId,
        provider: 'META_MANAGED',
        business: { userId }
      },
      include: {
        metaManagedCredential: true
      }
    });

    if (!instance || !instance.metaManagedCredential) {
      return res.status(404).json({ error: 'Instance not found or not a META_MANAGED instance' });
    }

    const credential = instance.metaManagedCredential;

    if (credential.status === 'ACTIVE') {
      return res.status(400).json({ error: 'Instance is already verified' });
    }

    const service = getMetaManagedService();
    const result = await service.verifyCode(credential.phoneNumberId, code);

    if (!result.success) {
      await prisma.metaManagedCredential.update({
        where: { id: credential.id },
        data: {
          verificationAttempts: { increment: 1 },
          lastVerificationAt: new Date(),
          status: credential.verificationAttempts >= 4 ? 'VERIFICATION_FAILED' : 'PENDING_VERIFICATION'
        }
      });

      return res.status(400).json({ 
        error: result.error || 'Invalid verification code',
        attemptsRemaining: 5 - credential.verificationAttempts - 1
      });
    }

    const phoneInfo = await service.getPhoneNumberInfo(credential.phoneNumberId);

    await prisma.metaManagedCredential.update({
      where: { id: credential.id },
      data: {
        status: 'ACTIVE',
        registeredAt: new Date(),
        qualityRating: phoneInfo?.quality_rating || null,
        messagingTier: phoneInfo?.messaging_limit_tier || null,
        verifiedName: phoneInfo?.verified_name || credential.verifiedName
      }
    });

    await prisma.whatsAppInstance.update({
      where: { id: instance.id },
      data: {
        status: 'connected',
        isActive: true,
        lastConnection: new Date()
      }
    });

    await prisma.whatsAppInstanceHistory.create({
      data: {
        instanceId: instance.id,
        businessId: instance.businessId,
        eventType: 'CONNECTED',
        newProvider: 'META_MANAGED',
        previousStatus: 'pending_verification',
        newStatus: 'connected',
        phoneNumber: instance.phoneNumber,
        details: 'Phone number verified and connected via META_MANAGED'
      }
    });

    res.json({
      success: true,
      instanceId: instance.id,
      status: 'connected',
      phoneInfo: {
        displayPhone: credential.displayPhone,
        verifiedName: phoneInfo?.verified_name || credential.verifiedName,
        qualityRating: phoneInfo?.quality_rating,
        messagingTier: phoneInfo?.messaging_limit_tier
      }
    });
  } catch (error: any) {
    console.error('[META_MANAGED] Verify error:', error);
    res.status(500).json({ error: error.message || 'Failed to verify phone number' });
  }
});

router.get('/instance/:instanceId', authMiddleware as any, async (req: Request, res: Response) => {
  try {
    const { instanceId } = req.params;
    const userId = (req as any).user?.id;

    const instance = await prisma.whatsAppInstance.findFirst({
      where: {
        id: instanceId,
        provider: 'META_MANAGED',
        business: { userId }
      },
      include: {
        metaManagedCredential: true,
        business: { select: { id: true, name: true } }
      }
    });

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    res.json({
      id: instance.id,
      name: instance.name,
      provider: instance.provider,
      status: instance.status,
      phoneNumber: instance.phoneNumber,
      isActive: instance.isActive,
      botEnabled: instance.botEnabled,
      credential: instance.metaManagedCredential ? {
        phoneNumberId: instance.metaManagedCredential.phoneNumberId,
        displayPhone: instance.metaManagedCredential.displayPhone,
        verifiedName: instance.metaManagedCredential.verifiedName,
        status: instance.metaManagedCredential.status,
        qualityRating: instance.metaManagedCredential.qualityRating,
        messagingTier: instance.metaManagedCredential.messagingTier,
        registeredAt: instance.metaManagedCredential.registeredAt
      } : null,
      business: instance.business
    });
  } catch (error: any) {
    console.error('[META_MANAGED] Get instance error:', error);
    res.status(500).json({ error: error.message || 'Failed to get instance' });
  }
});

router.delete('/instance/:instanceId', authMiddleware as any, async (req: Request, res: Response) => {
  try {
    const { instanceId } = req.params;
    const userId = (req as any).user?.id;

    const instance = await prisma.whatsAppInstance.findFirst({
      where: {
        id: instanceId,
        provider: 'META_MANAGED',
        business: { userId }
      },
      include: {
        metaManagedCredential: true
      }
    });

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    if (instance.metaManagedCredential) {
      const service = getMetaManagedService();
      try {
        await service.deletePhoneNumber(instance.metaManagedCredential.phoneNumberId);
      } catch (err) {
        console.warn('[META_MANAGED] Failed to delete phone from Meta:', err);
      }
    }

    await prisma.whatsAppInstanceHistory.create({
      data: {
        instanceId: instance.id,
        businessId: instance.businessId,
        eventType: 'DELETED',
        previousProvider: 'META_MANAGED',
        previousStatus: instance.status,
        phoneNumber: instance.phoneNumber,
        details: 'META_MANAGED instance deleted by user'
      }
    });

    await prisma.whatsAppInstance.delete({
      where: { id: instanceId }
    });

    res.json({ success: true, message: 'Instance deleted successfully' });
  } catch (error: any) {
    console.error('[META_MANAGED] Delete instance error:', error);
    res.status(500).json({ error: error.message || 'Failed to delete instance' });
  }
});

router.post('/refresh-info/:instanceId', authMiddleware as any, async (req: Request, res: Response) => {
  try {
    const { instanceId } = req.params;
    const userId = (req as any).user?.id;

    const instance = await prisma.whatsAppInstance.findFirst({
      where: {
        id: instanceId,
        provider: 'META_MANAGED',
        business: { userId }
      },
      include: {
        metaManagedCredential: true
      }
    });

    if (!instance || !instance.metaManagedCredential) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    const service = getMetaManagedService();
    const phoneInfo = await service.getPhoneNumberInfo(instance.metaManagedCredential.phoneNumberId);

    if (!phoneInfo) {
      return res.status(400).json({ error: 'Failed to fetch phone info from Meta' });
    }

    await prisma.metaManagedCredential.update({
      where: { id: instance.metaManagedCredential.id },
      data: {
        qualityRating: phoneInfo.quality_rating,
        messagingTier: phoneInfo.messaging_limit_tier,
        verifiedName: phoneInfo.verified_name
      }
    });

    res.json({
      success: true,
      phoneInfo: {
        displayPhone: phoneInfo.display_phone_number,
        verifiedName: phoneInfo.verified_name,
        qualityRating: phoneInfo.quality_rating,
        messagingTier: phoneInfo.messaging_limit_tier
      }
    });
  } catch (error: any) {
    console.error('[META_MANAGED] Refresh info error:', error);
    res.status(500).json({ error: error.message || 'Failed to refresh phone info' });
  }
});

export default router;

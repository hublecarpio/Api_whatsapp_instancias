import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import prisma from '../services/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { 
  MetaCoexistService, 
  createMetaCoexistInstance, 
  activateCoexistence 
} from '../services/metaCoexist';

const router = Router();

const pendingOAuthStates = new Map<string, { 
  businessId: string; 
  instanceId: string; 
  userId: string;
  expiresAt: number;
}>();

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingOAuthStates.entries()) {
    if (value.expiresAt < now) {
      pendingOAuthStates.delete(key);
    }
  }
}, 60000);

router.get('/start', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, instanceId } = req.query;
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId as string, userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found or access denied' });
    }

    let instance;
    
    if (instanceId) {
      instance = await prisma.whatsAppInstance.findFirst({
        where: {
          id: instanceId as string,
          businessId: businessId as string,
          business: { userId }
        }
      });

      if (!instance) {
        return res.status(404).json({ error: 'Instance not found or access denied' });
      }
    } else {
      const existingInstances = await prisma.whatsAppInstance.count({
        where: { businessId: businessId as string }
      });

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { subscriptionTier: true, isPro: true }
      });

      const tier = user?.subscriptionTier || 'BASIC';
      const isPro = user?.isPro || false;
      const maxInstances = isPro || tier === 'PRO' || tier === 'ENTERPRISE' ? 10 : 2;

      if (existingInstances >= maxInstances) {
        return res.status(400).json({ 
          error: `Has alcanzado el limite de ${maxInstances} instancias para tu plan ${tier}` 
        });
      }

      instance = await prisma.whatsAppInstance.create({
        data: {
          businessId: businessId as string,
          provider: 'META_COEXIST',
          status: 'pending_credentials',
          name: `WhatsApp Coexist ${existingInstances + 1}`
        }
      });
    }

    const config = MetaCoexistService.getMetaCoexistConfig();
    const service = new MetaCoexistService(config);

    const state = uuidv4();
    pendingOAuthStates.set(state, {
      businessId: businessId as string,
      instanceId: instance.id,
      userId,
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    const authUrl = service.getOAuthUrl(state);

    res.json({ redirectUrl: authUrl, state, instanceId: instance.id });
  } catch (error: any) {
    console.error('[META_COEXIST] OAuth start error:', error);
    res.status(500).json({ error: 'Failed to start OAuth flow' });
  }
});

const pendingTokens = new Map<string, {
  userAccessToken: string;
  businesses: any[];
  instanceId: string;
  businessId: string;
  expiresAt: number;
}>();

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingTokens.entries()) {
    if (value.expiresAt < now) {
      pendingTokens.delete(key);
    }
  }
}, 60000);

router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error, error_description } = req.query;
    
    // Use FRONTEND_URL for redirects in production (Docker), fallback to relative for dev
    const frontendUrl = process.env.FRONTEND_URL || '';

    if (error) {
      console.error('[META_COEXIST] OAuth error:', error, error_description);
      return res.redirect(`${frontendUrl}/dashboard/whatsapp?error=${encodeURIComponent(error_description as string || 'OAuth failed')}`);
    }

    if (!code || !state) {
      return res.redirect(`${frontendUrl}/dashboard/whatsapp?error=Missing code or state`);
    }

    const pendingState = pendingOAuthStates.get(state as string);
    if (!pendingState) {
      return res.redirect(`${frontendUrl}/dashboard/whatsapp?error=Invalid or expired OAuth state`);
    }

    pendingOAuthStates.delete(state as string);

    const { businessId, instanceId, userId } = pendingState;

    const config = MetaCoexistService.getMetaCoexistConfig();
    const service = new MetaCoexistService(config);

    const tokenResponse = await service.exchangeCodeForToken(code as string);
    const userAccessToken = tokenResponse.access_token;

    const businesses = await service.getConnectedBusinesses(userAccessToken);
    
    if (businesses.length === 0) {
      return res.redirect(`${frontendUrl}/dashboard/whatsapp?error=No businesses found in your Meta account`);
    }

    const sessionToken = uuidv4();
    pendingTokens.set(sessionToken, {
      userAccessToken,
      businesses,
      instanceId,
      businessId,
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    res.redirect(
      `${frontendUrl}/dashboard/whatsapp/meta-coexist-setup?` +
      `session=${sessionToken}`
    );
  } catch (error: any) {
    console.error('[META_COEXIST] OAuth callback error:', error);
    const frontendUrl = process.env.FRONTEND_URL || '';
    res.redirect(`${frontendUrl}/dashboard/whatsapp?error=${encodeURIComponent(error.message || 'OAuth callback failed')}`);
  }
});

router.get('/session/:sessionToken', async (req: Request, res: Response) => {
  try {
    const { sessionToken } = req.params;
    const userId = (req as any).user?.id;

    const session = pendingTokens.get(sessionToken);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    const instance = await prisma.whatsAppInstance.findFirst({
      where: {
        id: session.instanceId,
        businessId: session.businessId,
        business: { userId }
      }
    });

    if (!instance) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({
      instanceId: session.instanceId,
      businessId: session.businessId,
      metaBusinesses: session.businesses
    });
  } catch (error: any) {
    console.error('[META_COEXIST] Session fetch error:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

router.post('/setup', async (req: Request, res: Response) => {
  try {
    const { sessionToken, metaBusinessId, wabaId, phoneNumberId } = req.body;
    const userId = (req as any).user?.id;

    if (!sessionToken || !metaBusinessId || !wabaId || !phoneNumberId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const session = pendingTokens.get(sessionToken);
    if (!session) {
      return res.status(404).json({ error: 'Session expired. Please restart the OAuth flow.' });
    }

    const { instanceId, businessId, userAccessToken } = session;

    const instance = await prisma.whatsAppInstance.findFirst({
      where: {
        id: instanceId,
        businessId,
        business: { userId }
      }
    });

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found or access denied' });
    }

    const config = MetaCoexistService.getMetaCoexistConfig();
    const service = new MetaCoexistService(config);

    const phoneNumbers = await service.getPhoneNumbers(userAccessToken, wabaId);
    const phoneInfo = phoneNumbers.find(p => p.id === phoneNumberId);

    if (!phoneInfo) {
      return res.status(400).json({ error: 'Phone number not found in WABA' });
    }

    await createMetaCoexistInstance(businessId, instanceId, {
      wabaId,
      metaBusinessId,
      phoneNumberId,
      displayPhone: phoneInfo.display_phone_number,
      userAccessToken
    });

    pendingTokens.delete(sessionToken);

    res.json({ 
      success: true, 
      message: 'Setup initiated. Activating coexistence...',
      phoneNumber: phoneInfo.display_phone_number
    });
  } catch (error: any) {
    console.error('[META_COEXIST] Setup error:', error);
    res.status(500).json({ error: error.message || 'Setup failed' });
  }
});

router.post('/activate/:instanceId', async (req: Request, res: Response) => {
  try {
    const { instanceId } = req.params;
    const userId = (req as any).user?.id;

    const instance = await prisma.whatsAppInstance.findFirst({
      where: {
        id: instanceId,
        business: { userId }
      },
      include: { metaCoexistCredential: true }
    });

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found or access denied' });
    }

    if (!instance.metaCoexistCredential) {
      return res.status(400).json({ error: 'No coexist credentials found. Complete setup first.' });
    }

    const activated = await activateCoexistence(instanceId);

    if (activated) {
      res.json({ success: true, message: 'Coexistence activated successfully' });
    } else {
      res.status(500).json({ error: 'Failed to activate coexistence. Check Meta Business settings.' });
    }
  } catch (error: any) {
    console.error('[META_COEXIST] Activation error:', error);
    res.status(500).json({ error: error.message || 'Activation failed' });
  }
});

router.get('/status/:instanceId', async (req: Request, res: Response) => {
  try {
    const { instanceId } = req.params;
    const userId = (req as any).user?.id;

    const instance = await prisma.whatsAppInstance.findFirst({
      where: {
        id: instanceId,
        business: { userId }
      },
      include: { metaCoexistCredential: true }
    });

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    if (!instance.metaCoexistCredential) {
      return res.json({
        status: 'not_configured',
        coexistenceEnabled: false
      });
    }

    const credential = instance.metaCoexistCredential;
    const config = MetaCoexistService.getMetaCoexistConfig();
    const service = new MetaCoexistService(config);

    const token = credential.systemAccessToken || credential.userAccessToken;
    const isCoexistEnabled = await service.checkCoexistenceStatus(token, credential.phoneNumberId);

    res.json({
      status: instance.status,
      coexistStatus: credential.coexistStatus,
      coexistenceEnabled: isCoexistEnabled,
      phoneNumber: credential.displayPhone,
      qualityRating: credential.qualityRating,
      messagingTier: credential.messagingTier,
      lastSync: credential.lastSyncAt
    });
  } catch (error: any) {
    console.error('[META_COEXIST] Status error:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

router.get('/wabas', async (req: Request, res: Response) => {
  try {
    const { session, metaBusinessId } = req.query;

    if (!session) {
      return res.status(400).json({ error: 'Missing session token' });
    }

    const sessionData = pendingTokens.get(session as string);
    if (!sessionData) {
      return res.status(404).json({ error: 'Session expired' });
    }

    const config = MetaCoexistService.getMetaCoexistConfig();
    const service = new MetaCoexistService(config);

    if (metaBusinessId) {
      const wabas = await service.getWABAs(sessionData.userAccessToken, metaBusinessId as string);
      res.json({ wabas });
    } else {
      const businesses = await service.getConnectedBusinesses(sessionData.userAccessToken);
      const allWabas: any[] = [];
      
      for (const business of businesses) {
        const wabas = await service.getWABAs(sessionData.userAccessToken, business.id);
        allWabas.push(...wabas);
      }

      res.json({ wabas: allWabas });
    }
  } catch (error: any) {
    console.error('[META_COEXIST] WABAs error:', error);
    res.status(500).json({ error: 'Failed to get WABAs' });
  }
});

router.get('/phone-numbers', async (req: Request, res: Response) => {
  try {
    const { session, wabaId } = req.query;

    if (!session || !wabaId) {
      return res.status(400).json({ error: 'Missing session or wabaId' });
    }

    const sessionData = pendingTokens.get(session as string);
    if (!sessionData) {
      return res.status(404).json({ error: 'Session expired' });
    }

    const config = MetaCoexistService.getMetaCoexistConfig();
    const service = new MetaCoexistService(config);

    const phoneNumbers = await service.getPhoneNumbers(sessionData.userAccessToken, wabaId as string);

    res.json({ phoneNumbers });
  } catch (error: any) {
    console.error('[META_COEXIST] Phone numbers error:', error);
    res.status(500).json({ error: 'Failed to get phone numbers' });
  }
});

router.post('/disconnect/:instanceId', async (req: Request, res: Response) => {
  try {
    const { instanceId } = req.params;
    const userId = (req as any).user?.id;

    const instance = await prisma.whatsAppInstance.findFirst({
      where: {
        id: instanceId,
        business: { userId }
      },
      include: { metaCoexistCredential: true }
    });

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    if (instance.metaCoexistCredential) {
      await prisma.metaCoexistCredential.delete({
        where: { instanceId }
      });
    }

    await prisma.whatsAppInstance.update({
      where: { id: instanceId },
      data: {
        provider: 'BAILEYS',
        status: 'pending_qr',
        phoneNumber: null
      }
    });

    res.json({ success: true, message: 'Disconnected from Meta Coexistence' });
  } catch (error: any) {
    console.error('[META_COEXIST] Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// ============================================
// META EMBEDDED SIGNUP FLOW
// ============================================

// Get Embedded Signup configuration for frontend
router.get('/embedded-signup/config', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const appId = process.env.META_APP_ID;
    const configId = process.env.META_EMBEDDED_SIGNUP_CONFIG_ID;
    
    if (!appId) {
      return res.status(500).json({ error: 'META_APP_ID not configured' });
    }
    
    if (!configId) {
      return res.status(500).json({ error: 'META_EMBEDDED_SIGNUP_CONFIG_ID not configured' });
    }
    
    res.json({
      appId,
      configId,
      version: 'v21.0'
    });
  } catch (error: any) {
    console.error('[EMBEDDED_SIGNUP] Config error:', error);
    res.status(500).json({ error: 'Failed to get config' });
  }
});

// Handle Embedded Signup completion - receive tokens from frontend
router.post('/embedded-signup/complete', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    const { businessId, code, wabaId, phoneNumberId, provider = 'META_CLOUD' } = req.body;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    if (!businessId || !code || !wabaId || !phoneNumberId) {
      return res.status(400).json({ 
        error: 'Missing required parameters: businessId, code, wabaId, phoneNumberId' 
      });
    }
    
    // Validate provider
    const validProviders = ['META_CLOUD', 'META_COEXIST'];
    const selectedProvider = validProviders.includes(provider) ? provider : 'META_CLOUD';
    
    console.log('[EMBEDDED_SIGNUP] Completing signup:', { businessId, wabaId, phoneNumberId, provider: selectedProvider });
    
    // Verify business ownership
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found or access denied' });
    }
    
    // Check instance limits
    const existingInstances = await prisma.whatsAppInstance.count({
      where: { businessId }
    });
    
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionTier: true, isPro: true }
    });
    
    const tier = user?.subscriptionTier || 'BASIC';
    const isPro = user?.isPro || tier === 'PRO' || tier === 'ENTERPRISE';
    const maxInstances = isPro ? 10 : 2;
    
    if (existingInstances >= maxInstances) {
      return res.status(400).json({ 
        error: `Has alcanzado el limite de ${maxInstances} instancias para tu plan ${tier}` 
      });
    }
    
    // Exchange code for access token
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    
    if (!appId || !appSecret) {
      return res.status(500).json({ error: 'Meta app credentials not configured' });
    }
    
    const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?` +
      `client_id=${appId}&` +
      `client_secret=${appSecret}&` +
      `code=${code}`;
    
    const axios = (await import('axios')).default;
    const tokenResponse = await axios.get(tokenUrl);
    const accessToken = tokenResponse.data.access_token;
    
    if (!accessToken) {
      console.error('[EMBEDDED_SIGNUP] Token exchange failed:', tokenResponse.data);
      return res.status(400).json({ error: 'Failed to exchange code for access token' });
    }
    
    // Get phone number details from Meta API
    const phoneDetailsUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}?` +
      `fields=display_phone_number,verified_name,quality_rating&` +
      `access_token=${accessToken}`;
    
    let displayPhone = '';
    let verifiedName = '';
    
    try {
      const phoneResponse = await axios.get(phoneDetailsUrl);
      displayPhone = phoneResponse.data.display_phone_number || '';
      verifiedName = phoneResponse.data.verified_name || '';
      console.log('[EMBEDDED_SIGNUP] Phone details:', phoneResponse.data);
    } catch (phoneError: any) {
      console.warn('[EMBEDDED_SIGNUP] Could not fetch phone details:', phoneError.message);
    }
    
    // Create WhatsApp instance with selected provider
    const instanceName = verifiedName || `WhatsApp ${selectedProvider === 'META_COEXIST' ? 'Coexist' : 'Cloud'} ${existingInstances + 1}`;
    
    const instance = await prisma.whatsAppInstance.create({
      data: {
        businessId,
        name: instanceName,
        provider: selectedProvider,
        status: 'connected',
        phoneNumber: displayPhone,
        lastConnection: new Date()
      }
    });
    
    // Store credentials based on provider type
    if (selectedProvider === 'META_COEXIST') {
      // Store Meta Coexist credentials
      await prisma.metaCoexistCredential.create({
        data: {
          instanceId: instance.id,
          wabaId,
          metaBusinessId: wabaId,
          phoneNumberId,
          displayPhone,
          userAccessToken: accessToken,
          systemAccessToken: accessToken,
          coexistenceEnabled: true,
          coexistStatus: 'ACTIVE',
          qualityRating: 'GREEN',
          lastSyncAt: new Date()
        }
      });
      
      // Try to enable coexistence on Meta's side
      try {
        const coexistUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}`;
        await axios.post(coexistUrl, { is_coexistence_enabled: true }, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        console.log('[EMBEDDED_SIGNUP] Coexistence enabled on Meta side');
      } catch (coexistError: any) {
        console.warn('[EMBEDDED_SIGNUP] Could not enable coexistence (may already be enabled):', coexistError.message);
      }
    } else {
      // Store Meta Cloud credentials
      await prisma.metaCredential.create({
        data: {
          instanceId: instance.id,
          accessToken,
          businessId: wabaId,
          phoneNumberId,
          appId: appId,
          appSecret: appSecret,
          webhookVerifyToken: `wh_${require('crypto').randomBytes(16).toString('hex')}`
        }
      });
    }
    
    // Record instance history
    await prisma.whatsAppInstanceHistory.create({
      data: {
        instanceId: instance.id,
        businessId,
        eventType: 'CREATED',
        newProvider: selectedProvider,
        newStatus: 'connected',
        phoneNumber: displayPhone,
        details: `Created via Meta Embedded Signup - ${selectedProvider} (WABA: ${wabaId})`
      }
    });
    
    console.log('[EMBEDDED_SIGNUP] Instance created successfully:', instance.id, 'provider:', selectedProvider);
    
    res.json({
      success: true,
      instance: {
        id: instance.id,
        name: instance.name,
        phoneNumber: displayPhone,
        provider: selectedProvider,
        status: 'connected'
      }
    });
  } catch (error: any) {
    console.error('[EMBEDDED_SIGNUP] Complete error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: error.response?.data?.error?.message || error.message || 'Failed to complete signup' 
    });
  }
});

export default router;

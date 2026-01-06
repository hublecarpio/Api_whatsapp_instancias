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
    let { businessId, code, wabaId, phoneNumberId, metaBusinessId, provider = 'META_CLOUD' } = req.body;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    if (!businessId || !code) {
      return res.status(400).json({ 
        error: 'Missing required parameters: businessId, code' 
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
    
    // If wabaId or phoneNumberId not provided, fetch from Graph API
    if (!wabaId || !phoneNumberId) {
      console.log('[EMBEDDED_SIGNUP] wabaId/phoneNumberId not provided, fetching from Graph API...');
      try {
        // Get shared WABAs for this token
        const sharedWabasUrl = `https://graph.facebook.com/v21.0/debug_token?` +
          `input_token=${accessToken}&access_token=${appId}|${appSecret}`;
        
        const debugResponse = await axios.get(sharedWabasUrl);
        console.log('[EMBEDDED_SIGNUP] Token debug info:', JSON.stringify(debugResponse.data, null, 2));
        
        const granularScopes = debugResponse.data?.data?.granular_scopes || [];
        const wabaScope = granularScopes.find((s: any) => s.scope === 'whatsapp_business_management');
        const targetWabas = wabaScope?.target_ids || [];
        
        // Get Meta Business ID from business_management scope
        const businessScope = granularScopes.find((s: any) => s.scope === 'business_management');
        if (businessScope?.target_ids?.length > 0 && !metaBusinessId) {
          metaBusinessId = businessScope.target_ids[0];
          console.log('[EMBEDDED_SIGNUP] Found Meta Business ID from token:', metaBusinessId);
        }
        
        if (targetWabas.length > 0 && !wabaId) {
          wabaId = targetWabas[0];
          console.log('[EMBEDDED_SIGNUP] Found WABA from token:', wabaId);
        }
        
        // If we have wabaId but no phoneNumberId, get phone numbers from WABA
        if (wabaId && !phoneNumberId) {
          const phoneNumbersUrl = `https://graph.facebook.com/v21.0/${wabaId}/phone_numbers?` +
            `access_token=${accessToken}`;
          
          const phoneNumbersResponse = await axios.get(phoneNumbersUrl);
          const phoneNumbers = phoneNumbersResponse.data?.data || [];
          
          if (phoneNumbers.length > 0) {
            phoneNumberId = phoneNumbers[0].id;
            console.log('[EMBEDDED_SIGNUP] Found phone number from WABA:', phoneNumberId);
          }
        }
        
        // If still no metaBusinessId, try to get it from WABA owner
        if (wabaId && !metaBusinessId) {
          try {
            // Try owner_business_info first
            const wabaInfoUrl = `https://graph.facebook.com/v21.0/${wabaId}?` +
              `fields=owner_business_info,business&access_token=${accessToken}`;
            const wabaInfoResponse = await axios.get(wabaInfoUrl);
            if (wabaInfoResponse.data?.owner_business_info?.id) {
              metaBusinessId = wabaInfoResponse.data.owner_business_info.id;
              console.log('[EMBEDDED_SIGNUP] Found Meta Business ID from WABA owner_business_info:', metaBusinessId);
            } else if (wabaInfoResponse.data?.business?.id) {
              metaBusinessId = wabaInfoResponse.data.business.id;
              console.log('[EMBEDDED_SIGNUP] Found Meta Business ID from WABA business field:', metaBusinessId);
            }
          } catch (wabaInfoError: any) {
            console.warn('[EMBEDDED_SIGNUP] Could not get WABA owner info:', wabaInfoError.message);
          }
        }
        
        // Log telemetry if metaBusinessId still not found
        if (!metaBusinessId) {
          console.warn('[EMBEDDED_SIGNUP] TELEMETRY: metaBusinessId not resolved via Graph API fallback. Using wabaId as fallback identifier.');
        }
      } catch (fetchError: any) {
        console.error('[EMBEDDED_SIGNUP] Error fetching WABA/phone from API:', fetchError.response?.data || fetchError.message);
      }
    }
    
    // Final validation
    if (!wabaId || !phoneNumberId) {
      return res.status(400).json({ 
        error: 'No se pudo obtener la informacion de WhatsApp Business. Intenta de nuevo o verifica que completaste todo el flujo de Meta.' 
      });
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
          metaBusinessId: metaBusinessId || wabaId,
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

router.get('/diagnose', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    
    const credentials = await prisma.metaCoexistCredential.findMany({
      include: {
        instance: {
          include: { business: true }
        }
      }
    });
    
    const userCredentials = credentials.filter(c => c.instance?.business?.userId === userId);
    
    const diagnosis = userCredentials.map(cred => ({
      instanceId: cred.instanceId,
      instanceName: cred.instance?.name,
      provider: cred.instance?.provider,
      status: cred.instance?.status,
      coexistStatus: cred.coexistStatus,
      phoneNumberId: cred.phoneNumberId || 'MISSING',
      displayPhone: cred.displayPhone || 'MISSING',
      wabaId: cred.wabaId || 'MISSING',
      hasUserToken: !!cred.userAccessToken,
      hasSystemToken: !!cred.systemAccessToken,
      issue: !cred.phoneNumberId ? 'phoneNumberId is missing - webhooks will fail' : null
    }));
    
    res.json({
      totalCredentials: userCredentials.length,
      credentialsWithIssues: diagnosis.filter(d => d.issue).length,
      credentials: diagnosis
    });
  } catch (error: any) {
    console.error('[META_COEXIST] Diagnose error:', error);
    res.status(500).json({ error: error.message || 'Diagnosis failed' });
  }
});

router.post('/repair/:instanceId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    const { phoneNumberId } = req.body;
    const userId = req.userId;
    
    if (!phoneNumberId) {
      return res.status(400).json({ error: 'phoneNumberId is required in request body' });
    }
    
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
      return res.status(400).json({ error: 'No META_COEXIST credential found for this instance' });
    }
    
    const accessToken = instance.metaCoexistCredential.systemAccessToken || 
                        instance.metaCoexistCredential.userAccessToken;
    
    let displayPhone = instance.metaCoexistCredential.displayPhone;
    
    try {
      const phoneUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=display_phone_number&access_token=${accessToken}`;
      const phoneResponse = await axios.get(phoneUrl);
      displayPhone = phoneResponse.data.display_phone_number || displayPhone;
      console.log('[REPAIR] Fetched display phone:', displayPhone);
    } catch (fetchError: any) {
      console.warn('[REPAIR] Could not fetch phone details from Meta:', fetchError.message);
    }
    
    await prisma.metaCoexistCredential.update({
      where: { instanceId },
      data: {
        phoneNumberId,
        displayPhone
      }
    });
    
    await prisma.whatsAppInstance.update({
      where: { id: instanceId },
      data: { phoneNumber: displayPhone }
    });
    
    console.log(`[REPAIR] Updated credential for instance ${instanceId} with phoneNumberId ${phoneNumberId}`);
    
    res.json({
      success: true,
      message: 'Credential repaired successfully',
      phoneNumberId,
      displayPhone
    });
  } catch (error: any) {
    console.error('[META_COEXIST] Repair error:', error);
    res.status(500).json({ error: error.message || 'Repair failed' });
  }
});

router.get('/webhook-lookup/:phoneNumberId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { phoneNumberId } = req.params;
    const userId = req.userId;
    
    const metaCredential = await prisma.metaCredential.findFirst({
      where: { 
        phoneNumberId,
        instance: { business: { userId } }
      },
      include: { instance: { include: { business: true } } }
    });
    
    if (metaCredential?.instance) {
      return res.json({
        found: true,
        provider: 'META_CLOUD',
        instanceId: metaCredential.instance.id,
        businessId: metaCredential.instance.businessId,
        displayPhone: metaCredential.instance.phoneNumber
      });
    }
    
    const coexistCredential = await prisma.metaCoexistCredential.findFirst({
      where: { 
        phoneNumberId,
        instance: { business: { userId } }
      },
      include: { instance: { include: { business: true } } }
    });
    
    if (coexistCredential?.instance) {
      return res.json({
        found: true,
        provider: 'META_COEXIST',
        instanceId: coexistCredential.instance.id,
        businessId: coexistCredential.instance.businessId,
        displayPhone: coexistCredential.displayPhone
      });
    }
    
    const allCoexistCredentials = await prisma.metaCoexistCredential.findMany({
      where: { instance: { business: { userId } } },
      select: { phoneNumberId: true, displayPhone: true, instanceId: true }
    });
    
    const allMetaCredentials = await prisma.metaCredential.findMany({
      where: { instance: { business: { userId } } },
      select: { phoneNumberId: true, instanceId: true }
    });
    
    res.json({
      found: false,
      searchedFor: phoneNumberId,
      existingCoexistCredentials: allCoexistCredentials.map(c => ({
        phoneNumberId: c.phoneNumberId || 'NULL',
        displayPhone: c.displayPhone,
        instanceId: c.instanceId
      })),
      existingMetaCredentials: allMetaCredentials.map(c => ({
        phoneNumberId: c.phoneNumberId || 'NULL',
        instanceId: c.instanceId
      }))
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WEBHOOK AUTO-CONFIGURATION ENDPOINTS
// ============================================

const META_API_VERSION = 'v21.0';

// Check current webhook subscriptions for the Meta App
router.get('/webhook-subscriptions', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    
    if (!appId || !appSecret) {
      return res.status(500).json({ 
        error: 'META_APP_ID or META_APP_SECRET not configured',
        configured: false
      });
    }
    
    // Get app access token
    const appAccessToken = `${appId}|${appSecret}`;
    
    // Fetch current subscriptions
    const subscriptionsUrl = `https://graph.facebook.com/${META_API_VERSION}/${appId}/subscriptions`;
    const response = await axios.get(subscriptionsUrl, {
      params: { access_token: appAccessToken }
    });
    
    const wabaSubscription = response.data.data?.find(
      (sub: any) => sub.object === 'whatsapp_business_account'
    );
    
    if (!wabaSubscription) {
      return res.json({
        subscribed: false,
        message: 'No webhook subscription found for whatsapp_business_account',
        allSubscriptions: response.data.data || []
      });
    }
    
    // Check if messages field is subscribed
    const messagesField = wabaSubscription.fields?.find(
      (f: any) => f.name === 'messages'
    );
    
    res.json({
      subscribed: true,
      active: wabaSubscription.active,
      callbackUrl: wabaSubscription.callback_url,
      fields: wabaSubscription.fields || [],
      hasMessagesField: !!messagesField,
      recommendation: !messagesField 
        ? 'The "messages" field is not subscribed. Use POST /webhook-subscribe to fix this.'
        : 'Webhook is properly configured'
    });
  } catch (error: any) {
    console.error('[WEBHOOK] Check subscriptions error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to check webhook subscriptions',
      details: error.response?.data || error.message
    });
  }
});

// Subscribe webhook fields programmatically
router.post('/webhook-subscribe', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const webhookVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'efficore_webhook_token_2024';
    
    if (!appId || !appSecret) {
      return res.status(500).json({ 
        error: 'META_APP_ID or META_APP_SECRET not configured'
      });
    }
    
    // Determine webhook URL
    const apiUrl = process.env.API_URL || process.env.REPL_URL || 'https://api.efficore.es';
    const callbackUrl = `${apiUrl}/webhook/meta`;
    
    const appAccessToken = `${appId}|${appSecret}`;
    
    // Subscribe to webhook
    const subscribeUrl = `https://graph.facebook.com/${META_API_VERSION}/${appId}/subscriptions`;
    
    const subscribeData = {
      object: 'whatsapp_business_account',
      callback_url: callbackUrl,
      verify_token: webhookVerifyToken,
      fields: 'messages,message_template_status_update,account_update,phone_number_quality_update',
      access_token: appAccessToken
    };
    
    console.log('[WEBHOOK] Subscribing to webhook:', {
      callbackUrl,
      fields: subscribeData.fields
    });
    
    const response = await axios.post(subscribeUrl, null, { params: subscribeData });
    
    res.json({
      success: response.data.success === true,
      callbackUrl,
      verifyToken: webhookVerifyToken,
      subscribedFields: subscribeData.fields.split(','),
      message: response.data.success 
        ? 'Webhook subscribed successfully! Meta will now send events to your endpoint.'
        : 'Subscription request sent but success status unclear',
      rawResponse: response.data
    });
  } catch (error: any) {
    console.error('[WEBHOOK] Subscribe error:', error.response?.data || error.message);
    
    // Check if it's a verification failure
    const errorData = error.response?.data?.error;
    if (errorData?.error_subcode === 2200 || errorData?.message?.includes('verify')) {
      return res.status(400).json({
        error: 'Webhook verification failed',
        message: 'Meta could not verify your webhook endpoint. Make sure your server is running and publicly accessible.',
        details: errorData,
        troubleshooting: [
          'Ensure https://api.efficore.es/webhook/meta is accessible',
          'Check that META_WEBHOOK_VERIFY_TOKEN matches in your environment',
          'Verify SSL certificate is valid',
          'Check server logs for verification attempts'
        ]
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to subscribe webhook',
      details: error.response?.data || error.message
    });
  }
});

// Test webhook connectivity by sending a test event
router.post('/webhook-test/:instanceId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    const userId = req.userId;
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { 
        id: instanceId, 
        business: { userId } 
      },
      include: { 
        business: true,
        metaCoexistCredential: true
      }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    
    if (!instance.metaCoexistCredential?.phoneNumberId) {
      return res.status(400).json({ 
        error: 'Instance does not have a phoneNumberId configured',
        suggestion: 'Use POST /repair/:instanceId to set the phoneNumberId first'
      });
    }
    
    // Simulate a Meta webhook event to test the flow
    const testPayload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: instance.metaCoexistCredential.wabaId || 'test_waba_id',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: instance.metaCoexistCredential.displayPhone || instance.phoneNumber,
              phone_number_id: instance.metaCoexistCredential.phoneNumberId
            },
            statuses: [{
              id: `test_${Date.now()}`,
              status: 'delivered',
              timestamp: Math.floor(Date.now() / 1000).toString(),
              recipient_id: '0000000000',
              conversation: {
                id: `test_conversation_${Date.now()}`,
                origin: { type: 'service' }
              }
            }]
          },
          field: 'messages'
        }]
      }]
    };
    
    // Send to our own webhook endpoint to test the full flow
    const apiUrl = process.env.API_URL || process.env.REPL_URL || 'https://api.efficore.es';
    const webhookUrl = `${apiUrl}/webhook/meta`;
    
    const startTime = Date.now();
    
    try {
      const testResponse = await axios.post(webhookUrl, testPayload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });
      
      const duration = Date.now() - startTime;
      
      res.json({
        success: true,
        message: 'Test webhook event sent successfully',
        phoneNumberId: instance.metaCoexistCredential.phoneNumberId,
        webhookUrl,
        responseTime: `${duration}ms`,
        webhookResponse: testResponse.status
      });
    } catch (webhookError: any) {
      const duration = Date.now() - startTime;
      
      res.json({
        success: false,
        message: 'Webhook endpoint is not responding correctly',
        phoneNumberId: instance.metaCoexistCredential.phoneNumberId,
        webhookUrl,
        responseTime: `${duration}ms`,
        error: webhookError.message,
        troubleshooting: [
          'Check if the webhook endpoint is publicly accessible',
          'Verify SSL certificate is valid',
          'Check server logs for errors'
        ]
      });
    }
  } catch (error: any) {
    console.error('[WEBHOOK] Test error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Re-register webhook for an existing instance (for instances that were created before the fix)
router.post('/webhook-register/:instanceId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    const userId = req.userId;
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { 
        id: instanceId, 
        business: { userId } 
      },
      include: { 
        metaCoexistCredential: true
      }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    
    if (!instance.metaCoexistCredential) {
      return res.status(400).json({ error: 'Instance does not have Meta Coexist credentials' });
    }
    
    const credential = instance.metaCoexistCredential;
    
    if (!credential.wabaId) {
      return res.status(400).json({ 
        error: 'WABA ID is missing',
        suggestion: 'Reconnect the instance through the Meta Coexistence flow'
      });
    }
    
    const token = credential.systemAccessToken || credential.userAccessToken;
    if (!token) {
      return res.status(400).json({ error: 'No access token available' });
    }
    
    const config = MetaCoexistService.getMetaCoexistConfig();
    const service = new MetaCoexistService(config);
    
    const apiUrl = process.env.API_URL || 'https://api.efficore.es';
    const webhookUrl = `${apiUrl}/webhook/meta`;
    
    try {
      const registered = await service.registerWebhook(token, credential.wabaId, webhookUrl);
      
      res.json({
        success: registered,
        wabaId: credential.wabaId,
        phoneNumberId: credential.phoneNumberId,
        webhookUrl,
        message: registered 
          ? 'Webhook registered successfully! Meta will now send events to your endpoint.'
          : 'Registration request sent but success status unclear'
      });
    } catch (regError: any) {
      console.error('[META_COEXIST] Webhook registration error:', regError.response?.data || regError.message);
      
      res.status(400).json({
        success: false,
        error: 'Failed to register webhook with Meta',
        details: regError.response?.data || regError.message,
        troubleshooting: [
          'Check that the access token is still valid',
          'Verify the WABA ID is correct',
          'Ensure the webhook URL is publicly accessible',
          'Try reconnecting the instance through OAuth'
        ]
      });
    }
  } catch (error: any) {
    console.error('[WEBHOOK] Register error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verify Meta can reach our webhook (manual trigger)
router.get('/webhook-verify', async (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'efficore_webhook_token_2024';
  
  if (mode === 'subscribe' && token === expectedToken) {
    console.log('[WEBHOOK] Verification successful');
    return res.status(200).send(challenge);
  }
  
  // Return status info when accessed without verification params
  res.json({
    status: 'Webhook verification endpoint active',
    expectedToken: expectedToken.substring(0, 8) + '...',
    mainWebhookUrl: '/webhook/meta',
    usage: 'Meta will call this endpoint with hub.mode=subscribe, hub.verify_token, and hub.challenge'
  });
});

export default router;

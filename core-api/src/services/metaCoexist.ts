import axios from 'axios';
import { Prisma } from '@prisma/client';
import prisma from './prisma';
import { MetaCloudService, MetaMessagePayload } from './metaCloud';

const META_API_URL = 'https://graph.facebook.com/v21.0';
const META_AUTH_URL = 'https://www.facebook.com/v21.0/dialog/oauth';

export interface MetaCoexistConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  webhookVerifyToken: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

export interface EmbeddedSignupSession {
  sessionId: string;
  qrCodeUrl?: string;
  status: string;
}

export interface PhoneNumberInfo {
  id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating: string;
  messaging_limit_tier?: string;
}

export class MetaCoexistService {
  private config: MetaCoexistConfig;

  constructor(config: MetaCoexistConfig) {
    this.config = config;
  }

  getOAuthUrl(state: string): string {
    const scopes = [
      'business_management',
      'whatsapp_business_management',
      'whatsapp_business_messaging'
    ].join(',');

    const params = new URLSearchParams({
      client_id: this.config.appId,
      redirect_uri: this.config.redirectUri,
      scope: scopes,
      response_type: 'code',
      state
    });

    return `${META_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<OAuthTokenResponse> {
    const response = await axios.post(`${META_API_URL}/oauth/access_token`, null, {
      params: {
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        redirect_uri: this.config.redirectUri,
        code
      }
    });

    return response.data;
  }

  async getSystemUserToken(userAccessToken: string, systemUserId: string): Promise<string> {
    const response = await axios.get(`${META_API_URL}/${systemUserId}/access_tokens`, {
      headers: { Authorization: `Bearer ${userAccessToken}` }
    });

    if (response.data.data && response.data.data.length > 0) {
      return response.data.data[0].access_token;
    }

    throw new Error('No system user token found');
  }

  async getConnectedBusinesses(userAccessToken: string): Promise<any[]> {
    const response = await axios.get(`${META_API_URL}/me/businesses`, {
      headers: { Authorization: `Bearer ${userAccessToken}` },
      params: { fields: 'id,name,verification_status' }
    });

    return response.data.data || [];
  }

  async getWABAs(userAccessToken: string, businessId: string): Promise<any[]> {
    const response = await axios.get(
      `${META_API_URL}/${businessId}/owned_whatsapp_business_accounts`,
      {
        headers: { Authorization: `Bearer ${userAccessToken}` },
        params: { fields: 'id,name,currency,timezone_id,message_template_namespace' }
      }
    );

    return response.data.data || [];
  }

  async getPhoneNumbers(userAccessToken: string, wabaId: string): Promise<PhoneNumberInfo[]> {
    const response = await axios.get(
      `${META_API_URL}/${wabaId}/phone_numbers`,
      {
        headers: { Authorization: `Bearer ${userAccessToken}` },
        params: { 
          fields: 'id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,certificate,name_status,code_verification_status'
        }
      }
    );

    return response.data.data || [];
  }

  async enableCoexistence(accessToken: string, phoneNumberId: string): Promise<boolean> {
    try {
      const response = await axios.post(
        `${META_API_URL}/${phoneNumberId}`,
        { is_coexistence_enabled: true },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      return response.data.success === true;
    } catch (error: any) {
      console.error('[META_COEXIST] Error enabling coexistence:', error.response?.data || error.message);
      throw error;
    }
  }

  async checkCoexistenceStatus(accessToken: string, phoneNumberId: string): Promise<boolean> {
    try {
      const response = await axios.get(
        `${META_API_URL}/${phoneNumberId}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { fields: 'is_coexistence_enabled' }
        }
      );

      return response.data.is_coexistence_enabled === true;
    } catch (error: any) {
      console.error('[META_COEXIST] Error checking coexistence status:', error.response?.data || error.message);
      return false;
    }
  }

  async registerWebhook(accessToken: string, wabaId: string): Promise<boolean> {
    try {
      // The subscribed_apps endpoint just needs to be called with the access token
      // Webhook URL is configured at the App level in Facebook Developer Console
      const response = await axios.post(
        `${META_API_URL}/${wabaId}/subscribed_apps`,
        null,
        {
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );

      console.log('[META_COEXIST] Webhook subscription response:', response.data);
      return response.data.success === true;
    } catch (error: any) {
      console.error('[META_COEXIST] Error registering webhook:', error.response?.data || error.message);
      throw error;
    }
  }

  async checkWebhookSubscription(accessToken: string, wabaId: string): Promise<boolean> {
    try {
      const response = await axios.get(
        `${META_API_URL}/${wabaId}/subscribed_apps`,
        {
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );

      console.log('[META_COEXIST] Webhook subscription check:', response.data);
      return response.data.data && response.data.data.length > 0;
    } catch (error: any) {
      console.error('[META_COEXIST] Error checking webhook subscription:', error.response?.data || error.message);
      return false;
    }
  }

  async sendMessage(instanceId: string, payload: MetaMessagePayload): Promise<any> {
    const credential = await prisma.metaCoexistCredential.findUnique({
      where: { instanceId }
    });

    if (!credential) {
      throw new Error('Meta Coexist credential not found for instance');
    }

    const token = credential.systemAccessToken || credential.userAccessToken;
    
    const metaService = new MetaCloudService({
      accessToken: token,
      phoneNumberId: credential.phoneNumberId,
      businessId: credential.metaBusinessId
    });

    return metaService.sendMessage(payload);
  }

  async sendTextMessage(instanceId: string, to: string, text: string): Promise<any> {
    return this.sendMessage(instanceId, { to, text });
  }

  async getMediaUrl(instanceId: string, mediaId: string): Promise<string> {
    const credential = await prisma.metaCoexistCredential.findUnique({
      where: { instanceId }
    });

    if (!credential) {
      throw new Error('Meta Coexist credential not found');
    }

    const token = credential.systemAccessToken || credential.userAccessToken;

    const response = await axios.get(`${META_API_URL}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    return response.data.url;
  }

  async downloadMedia(instanceId: string, mediaUrl: string): Promise<Buffer> {
    const credential = await prisma.metaCoexistCredential.findUnique({
      where: { instanceId }
    });

    if (!credential) {
      throw new Error('Meta Coexist credential not found');
    }

    const token = credential.systemAccessToken || credential.userAccessToken;

    const response = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer'
    });

    return Buffer.from(response.data);
  }

  async getPhoneNumberInfo(instanceId: string): Promise<PhoneNumberInfo | null> {
    const credential = await prisma.metaCoexistCredential.findUnique({
      where: { instanceId }
    });

    if (!credential) {
      return null;
    }

    const token = credential.systemAccessToken || credential.userAccessToken;

    try {
      const response = await axios.get(
        `${META_API_URL}/${credential.phoneNumberId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: { 
            fields: 'id,display_phone_number,verified_name,quality_rating,messaging_limit_tier'
          }
        }
      );

      return response.data;
    } catch (error) {
      console.error('[META_COEXIST] Error getting phone info:', error);
      return null;
    }
  }

  async syncPhoneStatus(instanceId: string): Promise<void> {
    const info = await this.getPhoneNumberInfo(instanceId);
    
    if (info) {
      await prisma.metaCoexistCredential.update({
        where: { instanceId },
        data: {
          qualityRating: info.quality_rating,
          messagingTier: info.messaging_limit_tier,
          displayPhone: info.display_phone_number,
          lastSyncAt: new Date()
        }
      });
    }
  }

  async validateToken(accessToken: string): Promise<boolean> {
    try {
      const response = await axios.get(`${META_API_URL}/debug_token`, {
        params: {
          input_token: accessToken,
          access_token: `${this.config.appId}|${this.config.appSecret}`
        }
      });

      return response.data.data?.is_valid === true;
    } catch (error) {
      return false;
    }
  }

  async refreshTokenIfNeeded(instanceId: string): Promise<string | null> {
    const credential = await prisma.metaCoexistCredential.findUnique({
      where: { instanceId }
    });

    if (!credential) {
      return null;
    }

    if (credential.tokenExpiresAt && credential.tokenExpiresAt > new Date()) {
      return credential.systemAccessToken || credential.userAccessToken;
    }

    const isValid = await this.validateToken(credential.userAccessToken);
    
    if (!isValid) {
      await prisma.metaCoexistCredential.update({
        where: { instanceId },
        data: { coexistStatus: 'REVOKED' }
      });

      await prisma.whatsAppInstance.update({
        where: { id: instanceId },
        data: { status: 'token_expired' }
      });

      return null;
    }

    return credential.systemAccessToken || credential.userAccessToken;
  }

  static getMetaCoexistConfig(): MetaCoexistConfig {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const redirectUri = process.env.META_COEXIST_REDIRECT_URI || `${process.env.API_URL || ''}/auth/meta-coexist/callback`;
    const webhookVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'efficore_webhook_token';

    if (!appId || !appSecret) {
      throw new Error('META_APP_ID and META_APP_SECRET are required for Meta Coexistence');
    }

    return { appId, appSecret, redirectUri, webhookVerifyToken };
  }
}

export async function createMetaCoexistInstance(
  businessId: string,
  instanceId: string,
  data: {
    wabaId: string;
    metaBusinessId: string;
    phoneNumberId: string;
    displayPhone: string;
    userAccessToken: string;
    systemAccessToken?: string;
    tokenExpiresAt?: Date;
  }
): Promise<void> {
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.whatsAppInstance.update({
      where: { id: instanceId },
      data: {
        provider: 'META_COEXIST',
        status: 'connecting',
        phoneNumber: data.displayPhone
      }
    });

    await tx.metaCoexistCredential.upsert({
      where: { instanceId },
      create: {
        instanceId,
        wabaId: data.wabaId,
        metaBusinessId: data.metaBusinessId,
        phoneNumberId: data.phoneNumberId,
        displayPhone: data.displayPhone,
        userAccessToken: data.userAccessToken,
        systemAccessToken: data.systemAccessToken || null,
        tokenExpiresAt: data.tokenExpiresAt || null,
        coexistStatus: 'PENDING'
      },
      update: {
        wabaId: data.wabaId,
        metaBusinessId: data.metaBusinessId,
        phoneNumberId: data.phoneNumberId,
        displayPhone: data.displayPhone,
        userAccessToken: data.userAccessToken,
        systemAccessToken: data.systemAccessToken || null,
        tokenExpiresAt: data.tokenExpiresAt || null,
        coexistStatus: 'PENDING'
      }
    });
  });
}

export async function activateCoexistence(instanceId: string): Promise<boolean> {
  const credential = await prisma.metaCoexistCredential.findUnique({
    where: { instanceId },
    include: { instance: true }
  });

  if (!credential) {
    throw new Error('Credential not found');
  }

  const config = MetaCoexistService.getMetaCoexistConfig();
  const service = new MetaCoexistService(config);

  const token = credential.systemAccessToken || credential.userAccessToken;
  
  const enabled = await service.enableCoexistence(token, credential.phoneNumberId);

  if (enabled) {
    // CRITICAL: Register the app to receive webhooks for this WABA
    // Note: Webhook URL is configured at the App level in Facebook Developer Console
    try {
      const webhookRegistered = await service.registerWebhook(token, credential.wabaId);
      console.log(`[META_COEXIST] Webhook subscription for WABA ${credential.wabaId}: ${webhookRegistered ? 'SUCCESS' : 'FAILED'}`);
      
      if (!webhookRegistered) {
        console.warn('[META_COEXIST] Webhook registration failed, but coexistence is enabled. Webhooks may not work.');
      }
    } catch (webhookError: any) {
      console.error('[META_COEXIST] Webhook registration error:', webhookError.response?.data || webhookError.message);
      // Don't fail activation if webhook registration fails - user can manually configure
    }

    await prisma.$transaction([
      prisma.metaCoexistCredential.update({
        where: { instanceId },
        data: {
          coexistenceEnabled: true,
          coexistStatus: 'ACTIVE'
        }
      }),
      prisma.whatsAppInstance.update({
        where: { id: instanceId },
        data: {
          status: 'connected',
          lastConnection: new Date()
        }
      })
    ]);

    return true;
  }

  return false;
}

export async function getInstanceByPhoneNumberId(phoneNumberId: string): Promise<{
  instance: any;
  credential: any;
  business: any;
} | null> {
  const credential = await prisma.metaCoexistCredential.findFirst({
    where: { phoneNumberId },
    include: {
      instance: {
        include: { business: true }
      }
    }
  });

  if (!credential || !credential.instance) {
    return null;
  }

  return {
    instance: credential.instance,
    credential,
    business: credential.instance.business
  };
}

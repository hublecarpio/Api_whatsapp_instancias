import axios from 'axios';
import prisma from './prisma.js';

const META_API_URL = 'https://graph.facebook.com/v21.0';

export interface MetaManagedConfig {
  platformWabaId: string;
  platformAccessToken: string;
}

export interface PhoneRegistrationRequest {
  phoneNumber: string;
  verifiedName?: string;
  codeMethod?: 'SMS' | 'VOICE';
}

export interface PhoneVerificationRequest {
  phoneNumberId: string;
  code: string;
}

export interface RegisteredPhoneInfo {
  id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating: string;
  messaging_limit_tier?: string;
  code_verification_status?: string;
}

export class MetaManagedService {
  private config: MetaManagedConfig;

  constructor(config: MetaManagedConfig) {
    this.config = config;
  }

  isConfigured(): boolean {
    return !!(this.config.platformWabaId && this.config.platformAccessToken);
  }

  async registerPhoneNumber(request: PhoneRegistrationRequest): Promise<{
    success: boolean;
    phoneNumberId?: string;
    error?: string;
  }> {
    try {
      console.log('[META_MANAGED] Registering phone number:', request.phoneNumber);

      const response = await axios.post(
        `${META_API_URL}/${this.config.platformWabaId}/phone_numbers`,
        {
          cc: this.extractCountryCode(request.phoneNumber),
          phone_number: this.cleanPhoneNumber(request.phoneNumber),
          verified_name: request.verifiedName || 'Business',
          code_method: request.codeMethod || 'SMS'
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.platformAccessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('[META_MANAGED] Phone registration response:', response.data);

      return {
        success: true,
        phoneNumberId: response.data.id
      };
    } catch (error: any) {
      console.error('[META_MANAGED] Phone registration error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  async requestVerificationCode(
    phoneNumberId: string,
    method: 'SMS' | 'VOICE' = 'SMS'
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('[META_MANAGED] Requesting verification code for:', phoneNumberId);

      const response = await axios.post(
        `${META_API_URL}/${phoneNumberId}/request_code`,
        {
          code_method: method,
          language: 'es'
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.platformAccessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('[META_MANAGED] Verification code request response:', response.data);

      return { success: response.data.success || true };
    } catch (error: any) {
      console.error('[META_MANAGED] Verification code request error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  async verifyCode(
    phoneNumberId: string,
    code: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('[META_MANAGED] Verifying code for:', phoneNumberId);

      const response = await axios.post(
        `${META_API_URL}/${phoneNumberId}/verify_code`,
        { code },
        {
          headers: {
            Authorization: `Bearer ${this.config.platformAccessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('[META_MANAGED] Code verification response:', response.data);

      return { success: response.data.success || true };
    } catch (error: any) {
      console.error('[META_MANAGED] Code verification error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  async getPhoneNumberInfo(phoneNumberId: string): Promise<RegisteredPhoneInfo | null> {
    try {
      const response = await axios.get(`${META_API_URL}/${phoneNumberId}`, {
        headers: {
          Authorization: `Bearer ${this.config.platformAccessToken}`
        },
        params: {
          fields: 'id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,code_verification_status'
        }
      });

      return response.data;
    } catch (error: any) {
      console.error('[META_MANAGED] Get phone info error:', error.response?.data || error.message);
      return null;
    }
  }

  async listPhoneNumbers(): Promise<RegisteredPhoneInfo[]> {
    try {
      const response = await axios.get(
        `${META_API_URL}/${this.config.platformWabaId}/phone_numbers`,
        {
          headers: {
            Authorization: `Bearer ${this.config.platformAccessToken}`
          },
          params: {
            fields: 'id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,code_verification_status'
          }
        }
      );

      return response.data.data || [];
    } catch (error: any) {
      console.error('[META_MANAGED] List phone numbers error:', error.response?.data || error.message);
      return [];
    }
  }

  async sendMessage(
    phoneNumberId: string,
    to: string,
    text: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const response = await axios.post(
        `${META_API_URL}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to.replace(/\D/g, ''),
          type: 'text',
          text: { body: text }
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.platformAccessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        messageId: response.data.messages?.[0]?.id
      };
    } catch (error: any) {
      console.error('[META_MANAGED] Send message error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  async sendMediaMessage(
    phoneNumberId: string,
    to: string,
    mediaType: 'image' | 'audio' | 'video' | 'document',
    mediaUrl: string,
    caption?: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const payload: any = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to.replace(/\D/g, ''),
        type: mediaType
      };

      payload[mediaType] = { link: mediaUrl };
      if (caption && (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')) {
        payload[mediaType].caption = caption;
      }

      const response = await axios.post(
        `${META_API_URL}/${phoneNumberId}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${this.config.platformAccessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        messageId: response.data.messages?.[0]?.id
      };
    } catch (error: any) {
      console.error('[META_MANAGED] Send media error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  async deletePhoneNumber(phoneNumberId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await axios.delete(`${META_API_URL}/${phoneNumberId}`, {
        headers: {
          Authorization: `Bearer ${this.config.platformAccessToken}`
        }
      });

      return { success: true };
    } catch (error: any) {
      console.error('[META_MANAGED] Delete phone error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  async registerWebhook(): Promise<{ success: boolean; error?: string }> {
    try {
      const appAccessToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
      const callbackUrl = process.env.META_WEBHOOK_CALLBACK_URL || 
        `${process.env.BACKEND_URL || process.env.APP_DOMAIN}/webhook/meta`;
      const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'efficore_verify_token';

      const response = await axios.post(
        `${META_API_URL}/${this.config.platformWabaId}/subscribed_apps`,
        {},
        {
          headers: {
            Authorization: `Bearer ${this.config.platformAccessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('[META_MANAGED] Webhook subscription response:', response.data);
      return { success: response.data.success || true };
    } catch (error: any) {
      console.error('[META_MANAGED] Webhook subscription error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  private extractCountryCode(phoneNumber: string): string {
    const cleaned = phoneNumber.replace(/\D/g, '');
    if (cleaned.startsWith('51')) return '51';
    if (cleaned.startsWith('1')) return '1';
    if (cleaned.startsWith('52')) return '52';
    if (cleaned.startsWith('34')) return '34';
    if (cleaned.startsWith('57')) return '57';
    if (cleaned.startsWith('54')) return '54';
    if (cleaned.startsWith('56')) return '56';
    if (cleaned.startsWith('55')) return '55';
    if (cleaned.startsWith('593')) return '593';
    return cleaned.substring(0, 2);
  }

  private cleanPhoneNumber(phoneNumber: string): string {
    return phoneNumber.replace(/\D/g, '');
  }
}

let metaManagedServiceInstance: MetaManagedService | null = null;

export function getMetaManagedService(): MetaManagedService {
  if (!metaManagedServiceInstance) {
    metaManagedServiceInstance = new MetaManagedService({
      platformWabaId: process.env.PLATFORM_WABA_ID || '',
      platformAccessToken: process.env.PLATFORM_ACCESS_TOKEN || ''
    });
  }
  return metaManagedServiceInstance;
}

export async function findInstanceByManagedPhoneNumberId(
  phoneNumberId: string
): Promise<any | null> {
  const credential = await prisma.metaManagedCredential.findFirst({
    where: { phoneNumberId },
    include: {
      instance: {
        include: {
          business: true
        }
      }
    }
  });

  return credential?.instance || null;
}

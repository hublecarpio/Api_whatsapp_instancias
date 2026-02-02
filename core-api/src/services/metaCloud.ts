import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import https from 'https';
import dns from 'dns';
import { Agent, fetch as undiciFetch, setGlobalDispatcher, Dispatcher } from 'undici';

// Force IPv4 resolution globally to avoid IPv6 connection issues in Docker
dns.setDefaultResultOrder('ipv4first');

// Custom IPv4-only lookup function for undici
function ipv4Lookup(
  hostname: string,
  options: any,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void
): void {
  dns.lookup(hostname, { family: 4 }, (err, address, family) => {
    callback(err, address || '', family || 4);
  });
}

const META_API_URL = 'https://graph.facebook.com/v21.0';

// Per-instance circuit breaker state (keyed by phoneNumberId)
interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
  successCount: number;
}

const circuitBreakers = new Map<string, CircuitBreakerState>();

const CIRCUIT_BREAKER_THRESHOLD = 10; // Higher threshold per instance
const CIRCUIT_BREAKER_RESET_TIME = 30000; // 30 seconds (half-open)
const CIRCUIT_BREAKER_FULL_RESET_TIME = 120000; // 2 minutes (full reset)

function getCircuitBreaker(phoneNumberId: string): CircuitBreakerState {
  if (!circuitBreakers.has(phoneNumberId)) {
    circuitBreakers.set(phoneNumberId, {
      failures: 0,
      lastFailure: 0,
      isOpen: false,
      successCount: 0
    });
  }
  return circuitBreakers.get(phoneNumberId)!;
}

function checkCircuitBreaker(phoneNumberId: string): boolean {
  const cb = getCircuitBreaker(phoneNumberId);
  if (!cb.isOpen) return true;
  
  const timeSinceLastFailure = Date.now() - cb.lastFailure;
  
  // Full reset after 2 minutes - completely clear failures
  if (timeSinceLastFailure > CIRCUIT_BREAKER_FULL_RESET_TIME) {
    console.log(`[META-CB] Circuit breaker for ${phoneNumberId} FULLY RESET after ${Math.round(timeSinceLastFailure/1000)}s`);
    cb.isOpen = false;
    cb.failures = 0;
    cb.successCount = 0;
    return true;
  }
  
  // Half-open state after 30 seconds
  if (timeSinceLastFailure > CIRCUIT_BREAKER_RESET_TIME) {
    console.log(`[META-CB] Circuit breaker for ${phoneNumberId} entering half-open state (failures: ${cb.failures})...`);
    cb.isOpen = false;
    cb.failures = Math.floor(cb.failures / 2); // Reduce but don't reset completely
    return true;
  }
  
  console.log(`[META-CB] Circuit breaker OPEN for ${phoneNumberId} (failures: ${cb.failures}, retry in ${Math.round((CIRCUIT_BREAKER_RESET_TIME - timeSinceLastFailure)/1000)}s)`);
  return false;
}

export function getCircuitBreakerState(phoneNumberId: string): { isOpen: boolean; failures: number; timeSinceLastFailure: number } {
  const cb = getCircuitBreaker(phoneNumberId);
  return {
    isOpen: cb.isOpen,
    failures: cb.failures,
    timeSinceLastFailure: cb.lastFailure ? Date.now() - cb.lastFailure : 0
  };
}

function recordSuccess(phoneNumberId: string): void {
  const cb = getCircuitBreaker(phoneNumberId);
  cb.successCount++;
  // Reset failures faster on success
  if (cb.successCount >= 3) {
    cb.failures = 0;
    cb.successCount = 0;
  } else if (cb.failures > 0) {
    cb.failures--;
  }
}

function recordNetworkFailure(phoneNumberId: string): void {
  const cb = getCircuitBreaker(phoneNumberId);
  cb.failures++;
  cb.lastFailure = Date.now();
  cb.successCount = 0;
  
  if (cb.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    cb.isOpen = true;
    console.log(`[META-CB] Circuit breaker OPENED for ${phoneNumberId} after ${cb.failures} network failures`);
  }
}

// Helper to check if an error is a network timeout (not an API error)
function isNetworkTimeoutError(error: any): boolean {
  const errorCode = error?.code || error?.cause?.code || '';
  return errorCode === 'ETIMEDOUT' || 
         errorCode === 'ECONNRESET' || 
         errorCode === 'ENOTFOUND' ||
         errorCode === 'ECONNABORTED' ||
         errorCode === 'ESOCKETTIMEDOUT' ||
         errorCode === 'UND_ERR_CONNECT_TIMEOUT' ||
         error?.name === 'AbortError' ||
         error?.cause?.name === 'ConnectTimeoutError';
}

// Centralized Meta API request wrapper with unified retry logic
async function metaApiRequest(
  phoneNumberId: string,
  url: string,
  options: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: any;
    timeout?: number;
  },
  retryCount = 0
): Promise<any> {
  const maxRetries = 3;
  const useUndici = retryCount >= 1; // Use undici after first failure
  const timeout = options.timeout || (retryCount > 0 ? 60000 : 45000);
  
  // Check circuit breaker
  if (!checkCircuitBreaker(phoneNumberId)) {
    throw new Error('META_CIRCUIT_BREAKER_OPEN');
  }
  
  const startTime = Date.now();
  const logPrefix = `[META-REQ ${phoneNumberId.slice(-4)}]`;
  
  try {
    let responseData: any;
    
    if (useUndici) {
      const fetchOptions: any = {
        method: options.method,
        headers: options.headers
      };
      
      if (options.body) {
        fetchOptions.body = typeof options.body === 'string' 
          ? options.body 
          : JSON.stringify(options.body);
      }
      
      console.log(`${logPrefix} Undici ${options.method} attempt ${retryCount + 1}, timeout=${timeout}ms`);
      const response = await fetchWithTimeout(url, fetchOptions, timeout);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw { 
          response: { status: response.status, data: errorData }, 
          message: `HTTP ${response.status}`,
          isApiError: true
        };
      }
      
      responseData = await response.json();
      console.log(`${logPrefix} Undici SUCCESS in ${Date.now() - startTime}ms`);
    } else {
      const axiosConfig: any = {
        method: options.method,
        url,
        headers: options.headers,
        httpsAgent: retryCount > 0 ? freshAgent : httpsAgent,
        timeout
      };
      
      if (options.body) {
        axiosConfig.data = options.body;
      }
      
      console.log(`${logPrefix} Axios ${options.method} attempt ${retryCount + 1}, timeout=${timeout}ms, agent=${retryCount > 0 ? 'fresh' : 'pool'}`);
      
      const response = await axios(axiosConfig);
      responseData = response.data;
      console.log(`${logPrefix} Axios SUCCESS in ${Date.now() - startTime}ms`);
    }
    
    recordSuccess(phoneNumberId);
    return responseData;
  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    const isNetworkError = isNetworkTimeoutError(error);
    const errorCode = error?.code || error?.cause?.code || 'UNKNOWN';
    
    console.error(`${logPrefix} FAILED in ${elapsed}ms: code=${errorCode}, isNetwork=${isNetworkError}, msg=${error?.message?.substring(0, 100)}`);
    
    // Only record network failures to circuit breaker
    if (isNetworkError) {
      recordNetworkFailure(phoneNumberId);
    }
    
    if (isNetworkError && retryCount < maxRetries) {
      const delay = Math.min(1500 * Math.pow(1.5, retryCount), 8000);
      console.log(`${logPrefix} Retrying in ${delay}ms (attempt ${retryCount + 2}/${maxRetries + 1})...`);
      await new Promise(r => setTimeout(r, delay));
      return metaApiRequest(phoneNumberId, url, options, retryCount + 1);
    }
    
    throw error;
  }
}

// Undici agent with better connection handling
// Force IPv4 to avoid IPv6 connection issues in Docker containers
const undiciAgent = new Agent({
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 60000,
  connections: 50,
  pipelining: 1,
  connect: {
    timeout: 30000,
    autoSelectFamily: false, // Disable happy eyeballs
    lookup: ipv4Lookup, // Force IPv4-only DNS resolution
  }
});

// Legacy axios agent for backward compatibility
// Force IPv4 to avoid IPv6 connection issues in Docker containers
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 5000,
  timeout: 90000,
  maxSockets: 100,
  maxFreeSockets: 20,
  scheduling: 'fifo',
  family: 4 // Force IPv4
});

const metaAxios: AxiosInstance = axios.create({
  httpsAgent,
  timeout: 45000,
  headers: {
    'Connection': 'keep-alive'
  }
});

// Fresh agent for retries (no connection reuse)
// Force IPv4 to avoid IPv6 issues
const freshAgent = new https.Agent({
  keepAlive: false,
  timeout: 60000,
  family: 4 // Force IPv4
});

// Helper function for undici fetch with timeout
async function fetchWithTimeout(url: string, options: any, timeout: number): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await undiciFetch(url, {
      ...options,
      signal: controller.signal,
      dispatcher: undiciAgent
    });
    clearTimeout(timeoutId);
    return {
      ok: response.ok,
      status: response.status,
      json: () => response.json() as Promise<any>
    };
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

export interface MetaCredentials {
  accessToken: string;
  phoneNumberId: string;
  businessId: string;
}

export interface MetaMessagePayload {
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'document';
  caption?: string;
  filename?: string;
}

export interface MetaWebhookMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256: string; caption?: string };
  video?: { id: string; mime_type: string; sha256: string; caption?: string };
  audio?: { id: string; mime_type: string; sha256: string; voice?: boolean };
  document?: { id: string; mime_type: string; sha256: string; filename?: string; caption?: string };
  sticker?: { id: string; mime_type: string; animated?: boolean };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: Array<{ name: { formatted_name: string }; phones: Array<{ phone: string; type?: string }> }>;
  button?: { text: string; payload: string };
  interactive?: { 
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  reaction?: { message_id: string; emoji: string };
  context?: { from: string; id: string; referred_product?: any };
  referral?: { source_url: string; source_type: string; source_id: string; headline?: string; body?: string };
  order?: { catalog_id: string; product_items: Array<{ product_retailer_id: string; quantity: number; item_price: number; currency: string }> };
}

export interface MetaWebhookStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  conversation?: { id: string; origin?: { type: string } };
  pricing?: { billable: boolean; pricing_model: string; category: string };
  errors?: Array<{ code: number; title: string; message?: string; error_data?: { details: string } }>;
}

export interface ParsedStatus {
  messageId: string;
  status: string;
  timestamp: number;
  recipientId: string;
  conversationId?: string;
  originType?: string;
  isBillable?: boolean;
  errorCode?: number;
  errorTitle?: string;
  errorMessage?: string;
}

export interface ParsedWebhookResult {
  phoneNumberId: string;
  displayPhoneNumber: string;
  messages: ParsedMessage[];
  statuses: ParsedStatus[];
}

export interface ParsedMessage {
  from: string;
  pushName: string;
  messageId: string;
  timestamp: number;
  type: string;
  text?: string;
  mediaId?: string;
  mimetype?: string;
  caption?: string;
  filename?: string;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: Array<{ name: string; phones: string[] }>;
  buttonPayload?: string;
  buttonText?: string;
  interactiveType?: string;
  interactiveId?: string;
  interactiveTitle?: string;
  reaction?: { messageId: string; emoji: string };
  contextMessageId?: string;
  contextFrom?: string;
  isVoiceNote?: boolean;
  isAnimatedSticker?: boolean;
  order?: { catalogId: string; items: Array<{ productId: string; quantity: number; price: number; currency: string }> };
  referredProduct?: {
    catalogId?: string;
    productId: string;
    title?: string;
    description?: string;
    price?: number;
    currency?: string;
    imageUrl?: string;
  };
}

export interface MetaWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: {
          display_phone_number: string;
          phone_number_id: string;
        };
        contacts?: Array<{
          profile: { name: string };
          wa_id: string;
        }>;
        messages?: MetaWebhookMessage[];
        statuses?: Array<{
          id: string;
          status: string;
          timestamp: string;
          recipient_id: string;
        }>;
      };
      field: string;
    }>;
  }>;
}

export class MetaCloudService {
  private credentials: MetaCredentials;

  constructor(credentials: MetaCredentials) {
    this.credentials = credentials;
  }

  private get headers() {
    return {
      'Authorization': `Bearer ${this.credentials.accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  async sendTextMessage(to: string, text: string): Promise<any> {
    const cleanPhone = to.replace(/\D/g, '');
    console.log(`[META] sendTextMessage: to=${cleanPhone}, phoneNumberId=${this.credentials.phoneNumberId}, textLen=${text?.length}`);
    
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'text',
      text: { body: text }
    };
    
    const responseData = await metaApiRequest(
      this.credentials.phoneNumberId,
      `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: this.headers,
        body: payload
      }
    );

    const messageId = responseData?.messages?.[0]?.id;
    console.log(`[META] sendTextMessage SUCCESS: messageId=${messageId}`);
    return responseData;
  }

  async sendImageMessage(to: string, imageUrl: string, caption?: string): Promise<any> {
    const cleanPhone = to.replace(/\D/g, '');
    console.log(`[META] sendImageMessage: to=${cleanPhone}`);

    try {
      const { buffer, mimeType } = await this.downloadFromUrl(imageUrl);
      const mediaId = await this.uploadMedia(buffer, mimeType, 'image.jpg');
      
      return await metaApiRequest(
        this.credentials.phoneNumberId,
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: this.headers,
          body: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'image',
            image: { id: mediaId, caption: caption || '' }
          }
        }
      );
    } catch (uploadError: any) {
      console.error('[META] Image upload failed, trying direct URL:', uploadError.message);
      return await metaApiRequest(
        this.credentials.phoneNumberId,
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: this.headers,
          body: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'image',
            image: { link: imageUrl, caption: caption || '' }
          }
        }
      );
    }
  }

  async sendVideoMessage(to: string, videoUrl: string, caption?: string): Promise<any> {
    const cleanPhone = to.replace(/\D/g, '');
    console.log(`[META] sendVideoMessage: to=${cleanPhone}`);

    try {
      const { buffer, mimeType } = await this.downloadFromUrl(videoUrl);
      const mediaId = await this.uploadMedia(buffer, mimeType, 'video.mp4');
      
      return await metaApiRequest(
        this.credentials.phoneNumberId,
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: this.headers,
          body: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'video',
            video: { id: mediaId, caption: caption || '' }
          }
        }
      );
    } catch (uploadError: any) {
      console.error('[META] Video upload failed, trying direct URL:', uploadError.message);
      return await metaApiRequest(
        this.credentials.phoneNumberId,
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: this.headers,
          body: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'video',
            video: { link: videoUrl, caption: caption || '' }
          }
        }
      );
    }
  }

  /**
   * Upload media to Meta Cloud API.
   * NOTE: Uses axios with fresh agent on retries (not undici) because FormData 
   * multipart encoding with undici requires additional complexity that could 
   * introduce bugs. Axios with fresh agent still provides improved reliability.
   */
  async uploadMedia(buffer: Buffer, mimeType: string, filename: string, retryCount = 0): Promise<string> {
    const maxRetries = 2;
    
    // Check circuit breaker
    if (!checkCircuitBreaker(this.credentials.phoneNumberId)) {
      throw new Error('META_CIRCUIT_BREAKER_OPEN');
    }
    
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('file', buffer, { filename, contentType: mimeType });
    formData.append('type', mimeType);

    try {
      const response = await axios.post(
        `${META_API_URL}/${this.credentials.phoneNumberId}/media`,
        formData,
        {
          headers: {
            'Authorization': `Bearer ${this.credentials.accessToken}`,
            ...formData.getHeaders()
          },
          httpsAgent: retryCount > 0 ? freshAgent : httpsAgent,
          timeout: retryCount > 0 ? 90000 : 60000
        }
      );
      
      recordSuccess(this.credentials.phoneNumberId);
      return response.data.id;
    } catch (error: any) {
      const isNetworkError = isNetworkTimeoutError(error);
      
      if (isNetworkError) {
        recordNetworkFailure(this.credentials.phoneNumberId);
        
        if (retryCount < maxRetries) {
          const delay = 2000 * Math.pow(1.5, retryCount);
          console.log(`[META] Retrying uploadMedia in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          return this.uploadMedia(buffer, mimeType, filename, retryCount + 1);
        }
      }
      throw error;
    }
  }

  private async downloadFromUrl(url: string, retryCount = 0): Promise<{ buffer: Buffer; mimeType: string }> {
    const maxRetries = 2;
    
    // Check circuit breaker (uses phoneNumberId for consistency)
    if (!checkCircuitBreaker(this.credentials.phoneNumberId)) {
      throw new Error('META_CIRCUIT_BREAKER_OPEN');
    }
    
    try {
      // Use undici on retries for better reliability
      if (retryCount > 0) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);
        
        try {
          const response = await undiciFetch(url, {
            signal: controller.signal,
            dispatcher: undiciAgent
          });
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            throw { message: `HTTP ${response.status}` };
          }
          
          const arrayBuffer = await response.arrayBuffer();
          const mimeType = response.headers.get('content-type') || 'application/octet-stream';
          recordSuccess(this.credentials.phoneNumberId);
          return { buffer: Buffer.from(arrayBuffer), mimeType };
        } catch (error) {
          clearTimeout(timeoutId);
          throw error;
        }
      }
      
      const response = await metaAxios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000
      });
      const mimeType = response.headers['content-type'] || 'application/octet-stream';
      recordSuccess(this.credentials.phoneNumberId);
      return { buffer: Buffer.from(response.data), mimeType };
    } catch (error: any) {
      const isNetworkError = isNetworkTimeoutError(error);
      
      if (isNetworkError) {
        recordNetworkFailure(this.credentials.phoneNumberId);
      }
      
      if (isNetworkError && retryCount < maxRetries) {
        const delay = 1500 * Math.pow(1.5, retryCount);
        console.log(`[META] Retrying downloadFromUrl in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        return this.downloadFromUrl(url, retryCount + 1);
      }
      throw error;
    }
  }

  async sendAudioMessage(to: string, audioUrl: string): Promise<any> {
    const cleanPhone = to.replace(/\D/g, '');
    console.log(`[META] sendAudioMessage: to=${cleanPhone}`);

    try {
      const { buffer, mimeType } = await this.downloadFromUrl(audioUrl);
      console.log(`[META] Audio downloaded: ${buffer.length} bytes, Content-Type: ${mimeType}`);
      
      let actualMimeType = 'audio/mpeg';
      let extension = 'mp3';
      
      if (mimeType.includes('ogg') || mimeType.includes('opus')) {
        actualMimeType = 'audio/ogg; codecs=opus';
        extension = 'ogg';
      } else if (mimeType.includes('mpeg') || mimeType.includes('mp3')) {
        actualMimeType = 'audio/mpeg';
        extension = 'mp3';
      } else if (mimeType.includes('aac')) {
        actualMimeType = 'audio/aac';
        extension = 'aac';
      } else if (mimeType.includes('mp4') || mimeType.includes('m4a')) {
        actualMimeType = 'audio/mp4';
        extension = 'm4a';
      } else if (mimeType.includes('amr')) {
        actualMimeType = 'audio/amr';
        extension = 'amr';
      }
      
      const mediaId = await this.uploadMedia(buffer, actualMimeType, `voice.${extension}`);
      console.log('[META] Audio uploaded, media_id:', mediaId);
      
      return await metaApiRequest(
        this.credentials.phoneNumberId,
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: this.headers,
          body: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'audio',
            audio: { id: mediaId }
          }
        }
      );
    } catch (uploadError: any) {
      console.error('[META] Audio send failed:', uploadError.response?.data || uploadError.message);
      throw uploadError;
    }
  }

  async sendDocumentMessage(to: string, documentUrl: string, filename?: string, caption?: string): Promise<any> {
    const cleanPhone = to.replace(/\D/g, '');
    console.log(`[META] sendDocumentMessage: to=${cleanPhone}`);

    try {
      const { buffer, mimeType } = await this.downloadFromUrl(documentUrl);
      const mediaId = await this.uploadMedia(buffer, mimeType, filename || 'document');
      
      return await metaApiRequest(
        this.credentials.phoneNumberId,
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: this.headers,
          body: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'document',
            document: { id: mediaId, filename: filename || 'document', caption: caption || '' }
          }
        }
      );
    } catch (uploadError: any) {
      console.error('[META] Document upload failed, trying direct URL:', uploadError.message);
      return await metaApiRequest(
        this.credentials.phoneNumberId,
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: this.headers,
          body: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'document',
            document: { link: documentUrl, filename: filename || 'document', caption: caption || '' }
          }
        }
      );
    }
  }

  async sendMessage(payload: MetaMessagePayload): Promise<any> {
    if (payload.mediaUrl && payload.mediaType) {
      switch (payload.mediaType) {
        case 'image':
          return this.sendImageMessage(payload.to, payload.mediaUrl, payload.caption);
        case 'video':
          return this.sendVideoMessage(payload.to, payload.mediaUrl, payload.caption);
        case 'audio':
          return this.sendAudioMessage(payload.to, payload.mediaUrl);
        case 'document':
          return this.sendDocumentMessage(payload.to, payload.mediaUrl, payload.filename, payload.caption);
      }
    }

    if (payload.text) {
      return this.sendTextMessage(payload.to, payload.text);
    }

    throw new Error('Invalid message payload: must include text or media');
  }

  async getMediaUrl(mediaId: string, retryCount = 0): Promise<string> {
    const maxRetries = 3;
    console.log(`[META] getMediaUrl: fetching URL for mediaId=${mediaId}, phoneNumberId=${this.credentials.phoneNumberId}, retry=${retryCount}/${maxRetries}`);
    
    // Check circuit breaker
    if (!checkCircuitBreaker(this.credentials.phoneNumberId)) {
      throw new Error('META_CIRCUIT_BREAKER_OPEN');
    }
    
    try {
      // Use undici on retries for better connection handling
      if (retryCount >= 1) {
        const response = await fetchWithTimeout(
          `${META_API_URL}/${mediaId}`,
          {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${this.credentials.accessToken}`
            }
          },
          45000
        );
        
        if (!response.ok) {
          throw { response: { status: response.status }, message: `HTTP ${response.status}` };
        }
        
        const data = await response.json();
        recordSuccess(this.credentials.phoneNumberId);
        console.log(`[META] getMediaUrl: success for ${mediaId} (undici)`);
        return data.url;
      }
      
      const response = await metaAxios.get(
        `${META_API_URL}/${mediaId}`,
        { headers: this.headers, timeout: 30000 }
      );
      recordSuccess(this.credentials.phoneNumberId);
      console.log(`[META] getMediaUrl: success for ${mediaId} (axios)`);
      return response.data.url;
    } catch (error: any) {
      const isNetworkError = isNetworkTimeoutError(error);
      
      console.error(`[META] getMediaUrl FAILED for ${mediaId} (attempt ${retryCount + 1}/${maxRetries + 1}):`, {
        status: error?.response?.status,
        data: error?.response?.data,
        message: error?.message,
        code: error?.code || error?.cause?.code
      });
      
      // Record network failures to circuit breaker
      if (isNetworkError) {
        recordNetworkFailure(this.credentials.phoneNumberId);
      }
      
      if (isNetworkError && retryCount < maxRetries) {
        const delay = 1500 * Math.pow(1.5, retryCount);
        console.log(`[META] Retrying getMediaUrl in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        return this.getMediaUrl(mediaId, retryCount + 1);
      }
      throw error;
    }
  }

  async downloadMedia(mediaUrl: string, retryCount = 0): Promise<Buffer> {
    const maxRetries = 3;
    console.log(`[META] downloadMedia: downloading from ${mediaUrl?.substring(0, 80)}..., retry=${retryCount}/${maxRetries}`);
    
    // Check circuit breaker
    if (!checkCircuitBreaker(this.credentials.phoneNumberId)) {
      throw new Error('META_CIRCUIT_BREAKER_OPEN');
    }
    
    try {
      // Use undici on retries for better reliability
      if (retryCount >= 1) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 90000);
        
        try {
          const response = await undiciFetch(mediaUrl, {
            headers: { 'Authorization': `Bearer ${this.credentials.accessToken}` },
            signal: controller.signal,
            dispatcher: undiciAgent
          });
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            throw { response: { status: response.status }, message: `HTTP ${response.status}` };
          }
          
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          recordSuccess(this.credentials.phoneNumberId);
          console.log(`[META] downloadMedia: success, size=${buffer.byteLength} bytes (undici)`);
          return buffer;
        } catch (error) {
          clearTimeout(timeoutId);
          throw error;
        }
      }
      
      const response = await metaAxios.get(mediaUrl, {
        headers: { 'Authorization': `Bearer ${this.credentials.accessToken}` },
        responseType: 'arraybuffer',
        timeout: 60000
      });
      recordSuccess(this.credentials.phoneNumberId);
      console.log(`[META] downloadMedia: success, size=${response.data.byteLength} bytes (axios)`);
      return Buffer.from(response.data);
    } catch (error: any) {
      const isNetworkError = isNetworkTimeoutError(error);
      
      console.error(`[META] downloadMedia FAILED (attempt ${retryCount + 1}/${maxRetries + 1}):`, {
        status: error?.response?.status,
        message: error?.message,
        code: error?.code || error?.cause?.code
      });
      
      // Record network failures to circuit breaker
      if (isNetworkError) {
        recordNetworkFailure(this.credentials.phoneNumberId);
      }
      
      if (isNetworkError && retryCount < maxRetries) {
        const delay = 2000 * Math.pow(1.5, retryCount);
        console.log(`[META] Retrying downloadMedia in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        return this.downloadMedia(mediaUrl, retryCount + 1);
      }
      throw error;
    }
  }

  async getPhoneNumberInfo(): Promise<any> {
    return await metaApiRequest(
      this.credentials.phoneNumberId,
      `${META_API_URL}/${this.credentials.phoneNumberId}`,
      {
        method: 'GET',
        headers: this.headers,
        timeout: 10000
      }
    );
  }

  async markMessageAsRead(messageId: string): Promise<any> {
    return await metaApiRequest(
      this.credentials.phoneNumberId,
      `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: this.headers,
        body: {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId
        }
      }
    );
  }

  async sendTemplate(options: {
    to: string;
    templateName: string;
    language: string;
    components?: Array<{
      type: 'header' | 'body' | 'button';
      parameters?: Array<{ type: string; text?: string; image?: { link: string }; document?: { link: string } }>;
    }>;
  }): Promise<any> {
    const cleanPhone = options.to.replace(/\D/g, '');
    console.log(`[META] sendTemplate: to=${cleanPhone}, template=${options.templateName}`);

    const payload: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'template',
      template: {
        name: options.templateName,
        language: { code: options.language }
      }
    };

    if (options.components && options.components.length > 0) {
      payload.template.components = options.components;
    }

    return await metaApiRequest(
      this.credentials.phoneNumberId,
      `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: this.headers,
        body: payload
      }
    );
  }

  async getTemplates(): Promise<any[]> {
    const response = await metaApiRequest(
      this.credentials.phoneNumberId,
      `${META_API_URL}/${this.credentials.businessId}/message_templates`,
      {
        method: 'GET',
        headers: this.headers
      }
    );

    return response.data || [];
  }

  static parseWebhookMessage(payload: MetaWebhookPayload): ParsedWebhookResult | null {
    if (payload.object !== 'whatsapp_business_account') {
      return null;
    }

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const phoneNumberId = value.metadata.phone_number_id;
        const displayPhoneNumber = value.metadata.display_phone_number;
        const contacts = value.contacts || [];
        const messages = value.messages || [];
        const statuses = value.statuses || [];

        const parsedMessages: ParsedMessage[] = messages.map(msg => {
          const contact = contacts.find(c => c.wa_id === msg.from);
          const pushName = contact?.profile?.name || '';

          const parsed: ParsedMessage = {
            from: msg.from,
            pushName,
            messageId: msg.id,
            timestamp: parseInt(msg.timestamp) * 1000,
            type: msg.type
          };

          if (msg.context) {
            parsed.contextMessageId = msg.context.id;
            parsed.contextFrom = msg.context.from;
            
            // Parse referred product from catalog (when user replies to a catalog product)
            if (msg.context.referred_product) {
              const refProd = msg.context.referred_product;
              parsed.referredProduct = {
                catalogId: refProd.catalog_id,
                productId: refProd.product_retailer_id || 'unknown',
                title: undefined, // Not available in context, will need to be looked up
                description: undefined,
                price: undefined,
                currency: undefined,
                imageUrl: undefined
              };
              console.log(`[META PARSE] Referred product detected:`, {
                catalogId: refProd.catalog_id,
                productId: refProd.product_retailer_id
              });
            }
          }

          switch (msg.type) {
            case 'text':
              parsed.text = msg.text?.body;
              break;
            case 'image':
              parsed.mediaId = msg.image?.id;
              parsed.mimetype = msg.image?.mime_type;
              parsed.caption = msg.image?.caption;
              break;
            case 'video':
              parsed.mediaId = msg.video?.id;
              parsed.mimetype = msg.video?.mime_type;
              parsed.caption = msg.video?.caption;
              break;
            case 'audio':
              parsed.mediaId = msg.audio?.id;
              parsed.mimetype = msg.audio?.mime_type;
              parsed.isVoiceNote = msg.audio?.voice === true;
              break;
            case 'document':
              parsed.mediaId = msg.document?.id;
              parsed.mimetype = msg.document?.mime_type;
              parsed.filename = msg.document?.filename;
              parsed.caption = msg.document?.caption;
              break;
            case 'sticker':
              parsed.mediaId = msg.sticker?.id;
              parsed.mimetype = msg.sticker?.mime_type;
              parsed.isAnimatedSticker = msg.sticker?.animated === true;
              break;
            case 'location':
              parsed.location = msg.location;
              break;
            case 'contacts':
              if (msg.contacts) {
                parsed.contacts = msg.contacts.map(c => ({
                  name: c.name.formatted_name,
                  phones: c.phones.map(p => p.phone)
                }));
              }
              break;
            case 'button':
              parsed.buttonText = msg.button?.text;
              parsed.buttonPayload = msg.button?.payload;
              parsed.text = msg.button?.text;
              break;
            case 'interactive':
              parsed.interactiveType = msg.interactive?.type;
              if (msg.interactive?.button_reply) {
                parsed.interactiveId = msg.interactive.button_reply.id;
                parsed.interactiveTitle = msg.interactive.button_reply.title;
                parsed.text = msg.interactive.button_reply.title;
              } else if (msg.interactive?.list_reply) {
                parsed.interactiveId = msg.interactive.list_reply.id;
                parsed.interactiveTitle = msg.interactive.list_reply.title;
                parsed.text = msg.interactive.list_reply.title;
              }
              break;
            case 'reaction':
              if (msg.reaction) {
                parsed.reaction = {
                  messageId: msg.reaction.message_id,
                  emoji: msg.reaction.emoji
                };
              }
              break;
            case 'order':
              if (msg.order) {
                parsed.order = {
                  catalogId: msg.order.catalog_id,
                  items: msg.order.product_items.map(item => ({
                    productId: item.product_retailer_id,
                    quantity: item.quantity,
                    price: item.item_price,
                    currency: item.currency
                  }))
                };
              }
              break;
          }

          return parsed;
        });

        const parsedStatuses: ParsedStatus[] = statuses.map((s: any) => ({
          messageId: s.id,
          status: s.status,
          timestamp: parseInt(s.timestamp) * 1000,
          recipientId: s.recipient_id,
          conversationId: s.conversation?.id,
          originType: s.conversation?.origin?.type,
          isBillable: s.pricing?.billable,
          errorCode: s.errors?.[0]?.code,
          errorTitle: s.errors?.[0]?.title,
          errorMessage: s.errors?.[0]?.message || s.errors?.[0]?.error_data?.details
        }));

        return { 
          phoneNumberId, 
          displayPhoneNumber,
          messages: parsedMessages, 
          statuses: parsedStatuses 
        };
      }
    }

    return null;
  }

  async markAsRead(messageId: string): Promise<void> {
    try {
      await metaApiRequest(
        this.credentials.phoneNumberId,
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: this.headers,
          body: {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: messageId
          }
        }
      );
      console.log(`[META] markAsRead SUCCESS: messageId=${messageId}`);
    } catch (error: any) {
      console.warn(`[META] markAsRead FAILED: ${error.message}`);
    }
  }
}

import axios from 'axios';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiResponse {
  success: boolean;
  text: string;
  error?: string;
}

export class GeminiService {
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || GEMINI_API_KEY || '';
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  private async downloadMedia(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000
    });
    const mimeType = response.headers['content-type'] || 'application/octet-stream';
    return { buffer: Buffer.from(response.data), mimeType };
  }

  async transcribeAudio(audioUrl: string): Promise<GeminiResponse> {
    if (!this.isConfigured()) {
      return { success: false, text: '', error: 'Gemini API not configured' };
    }

    try {
      console.log('[GEMINI] Transcribing audio from:', audioUrl);
      const { buffer, mimeType } = await this.downloadMedia(audioUrl);
      const base64Data = buffer.toString('base64');

      const response = await axios.post(
        `${GEMINI_API_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`,
        {
          contents: [{
            parts: [
              {
                inline_data: {
                  mime_type: mimeType.split(';')[0],
                  data: base64Data
                }
              },
              {
                text: 'Transcribe este audio exactamente como se habla. Solo devuelve la transcripción, nada más. Si no puedes transcribirlo, devuelve "[Audio no disponible]".'
              }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1536
          }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 60000
        }
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log('[GEMINI] Audio transcription:', text.substring(0, 100));
      
      return { success: true, text: text.trim() };
    } catch (error: any) {
      console.error('[GEMINI] Audio transcription failed:', error.response?.data || error.message);
      return { 
        success: false, 
        text: '', 
        error: error.response?.data?.error?.message || error.message 
      };
    }
  }

  async analyzeImage(imageUrl: string, context?: string): Promise<GeminiResponse> {
    if (!this.isConfigured()) {
      return { success: false, text: '', error: 'Gemini API not configured' };
    }

    try {
      console.log('[GEMINI] Analyzing image from:', imageUrl);
      const { buffer, mimeType } = await this.downloadMedia(imageUrl);
      const base64Data = buffer.toString('base64');

      const prompt = context 
        ? `Describe brevemente esta imagen en español (máximo 2 oraciones). Contexto: "${context}".`
        : 'Describe brevemente esta imagen en español, máximo 2 oraciones. Sé conciso.';

      const response = await axios.post(
        `${GEMINI_API_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`,
        {
          contents: [{
            parts: [
              {
                inline_data: {
                  mime_type: mimeType.split(';')[0],
                  data: base64Data
                }
              },
              { text: prompt }
            ]
          }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 128
          }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 60000
        }
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log('[GEMINI] Image analysis:', text.substring(0, 100));
      
      return { success: true, text: text.trim() };
    } catch (error: any) {
      console.error('[GEMINI] Image analysis failed:', error.response?.data || error.message);
      return { 
        success: false, 
        text: '', 
        error: error.response?.data?.error?.message || error.message 
      };
    }
  }

  async analyzeVideo(videoUrl: string, context?: string): Promise<GeminiResponse> {
    if (!this.isConfigured()) {
      return { success: false, text: '', error: 'Gemini API not configured' };
    }

    try {
      console.log('[GEMINI] Analyzing video from:', videoUrl);
      const { buffer, mimeType } = await this.downloadMedia(videoUrl);
      
      if (buffer.length > 20 * 1024 * 1024) {
        return { 
          success: false, 
          text: '', 
          error: 'Video too large (max 20MB for inline processing)' 
        };
      }

      const base64Data = buffer.toString('base64');

      const prompt = context
        ? `Describe brevemente este video en español (máximo 2 oraciones). Contexto: "${context}".`
        : 'Describe brevemente este video en español, máximo 2 oraciones. Sé conciso.';

      const response = await axios.post(
        `${GEMINI_API_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`,
        {
          contents: [{
            parts: [
              {
                inline_data: {
                  mime_type: mimeType.split(';')[0],
                  data: base64Data
                }
              },
              { text: prompt }
            ]
          }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 128
          }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 120000
        }
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log('[GEMINI] Video analysis:', text.substring(0, 100));
      
      return { success: true, text: text.trim() };
    } catch (error: any) {
      console.error('[GEMINI] Video analysis failed:', error.response?.data || error.message);
      return { 
        success: false, 
        text: '', 
        error: error.response?.data?.error?.message || error.message 
      };
    }
  }

  async processMedia(mediaUrl: string, mediaType: string, context?: string): Promise<GeminiResponse> {
    if (!this.isConfigured()) {
      console.log('[GEMINI] Not configured, skipping media processing');
      return { success: false, text: '', error: 'Gemini API not configured' };
    }

    console.log(`[GEMINI] Processing ${mediaType} media`);

    switch (mediaType) {
      case 'audio':
      case 'ptt':
        return this.transcribeAudio(mediaUrl);
      case 'image':
      case 'sticker':
        return this.analyzeImage(mediaUrl, context);
      case 'video':
        return this.analyzeVideo(mediaUrl, context);
      default:
        return { 
          success: false, 
          text: '', 
          error: `Unsupported media type: ${mediaType}` 
        };
    }
  }

  async analyzeLeadStage(
    conversationHistory: { role: string; content: string }[],
    availableStages: { name: string; description: string }[]
  ): Promise<{ success: boolean; stageName: string; confidence: number; reasoning: string; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, stageName: '', confidence: 0, reasoning: '', error: 'Gemini API not configured' };
    }

    try {
      const stagesList = availableStages.map((s, i) => `${i + 1}. "${s.name}": ${s.description}`).join('\n');
      
      const conversationText = conversationHistory
        .slice(-20)
        .map(msg => `${msg.role === 'assistant' ? 'Agente' : 'Cliente'}: ${msg.content}`)
        .join('\n');

      const prompt = `Analiza esta conversación de WhatsApp entre un agente de ventas y un cliente potencial.

ETAPAS DISPONIBLES:
${stagesList}

CONVERSACIÓN:
${conversationText}

Determina en qué etapa del embudo de ventas se encuentra este lead basándote en el contenido de la conversación.

Responde SOLO en formato JSON con esta estructura exacta:
{
  "stageName": "nombre exacto de la etapa",
  "confidence": 0.85,
  "reasoning": "breve explicación de por qué esta etapa"
}

Reglas:
- Si el cliente acaba de escribir su primer mensaje, es "Nuevo"
- Si pregunta por productos, precios o muestra interés, es "Interesado"
- Si está negociando, pidiendo descuentos o hablando de condiciones, es "Negociando"
- Si se envió enlace de pago o está por cerrar la compra, sigue siendo "Negociando" hasta que pague
- Si ya pagó o confirmó la compra, es "Cerrado"
- Si dice que no le interesa o deja de responder por mucho tiempo, es "Perdido"
- Si está esperando algo (respuesta, decisión), es "Pendiente"`;

      const response = await axios.post(
        `${GEMINI_API_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 256
          }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        }
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { success: false, stageName: '', confidence: 0, reasoning: '', error: 'Invalid response format' };
      }

      const result = JSON.parse(jsonMatch[0]);
      console.log('[GEMINI] Lead stage analysis:', result);

      return {
        success: true,
        stageName: result.stageName || '',
        confidence: result.confidence || 0,
        reasoning: result.reasoning || ''
      };
    } catch (error: any) {
      console.error('[GEMINI] Lead stage analysis failed:', error.response?.data || error.message);
      return {
        success: false,
        stageName: '',
        confidence: 0,
        reasoning: '',
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  async extractContactData(
    conversationHistory: { role: string; content: string }[],
    requiredFields: string[]
  ): Promise<{ success: boolean; data: Record<string, string>; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, data: {}, error: 'Gemini API not configured' };
    }

    try {
      const conversationText = conversationHistory
        .slice(-30)
        .map(msg => `${msg.role === 'assistant' ? 'Agente' : 'Cliente'}: ${msg.content}`)
        .join('\n');

      const fieldsList = requiredFields.join(', ');

      const prompt = `Extrae los siguientes datos del cliente de esta conversación de WhatsApp:

DATOS A EXTRAER: ${fieldsList}

CONVERSACIÓN:
${conversationText}

Responde SOLO en formato JSON con los datos encontrados. Usa null para datos no encontrados.
Ejemplo: {"nombre": "Juan Pérez", "email": null, "direccion": "Av. Principal 123"}

Solo incluye los campos solicitados.`;

      const response = await axios.post(
        `${GEMINI_API_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 512
          }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        }
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { success: false, data: {}, error: 'Invalid response format' };
      }

      const result = JSON.parse(jsonMatch[0]);
      console.log('[GEMINI] Contact data extraction:', result);

      return { success: true, data: result };
    } catch (error: any) {
      console.error('[GEMINI] Contact data extraction failed:', error.response?.data || error.message);
      return {
        success: false,
        data: {},
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  async validatePaymentVoucher(
    imageUrl: string,
    expectedData?: {
      amount?: number;
      currency?: string;
      brandHints?: string[];
    }
  ): Promise<{
    isValid: boolean;
    isPaymentProof: boolean;
    brand?: string;
    amount?: number;
    currency?: string;
    operationCode?: string;
    confidence: number;
    reason: string;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { 
        isValid: false, 
        isPaymentProof: false, 
        confidence: 0, 
        reason: '', 
        error: 'Gemini API not configured' 
      };
    }

    try {
      console.log('[GEMINI] Validating payment voucher from:', imageUrl);
      const { buffer, mimeType } = await this.downloadMedia(imageUrl);
      const base64Data = buffer.toString('base64');

      const brandHints = expectedData?.brandHints?.join(', ') || 
        'BCP, BBVA, Interbank, Scotiabank, Yape, Plin, Nequi, Mercado Pago, PayPal, Zelle, Binance, Western Union';

      let amountContext = '';
      if (expectedData?.amount) {
        amountContext = `El monto esperado es aproximadamente ${expectedData.currency || ''}${expectedData.amount}.`;
      }

      const prompt = `Analiza esta imagen y determina si es un comprobante de pago válido (voucher de transferencia bancaria, captura de pago móvil, recibo de transacción, etc).

BANCOS/APPS COMUNES: ${brandHints}
${amountContext}

Responde SOLO en formato JSON con esta estructura exacta:
{
  "isPaymentProof": true/false,
  "isValid": true/false,
  "brand": "nombre del banco o app de pago detectado (o null)",
  "amount": número del monto detectado (o null),
  "currency": "código de moneda detectado: PEN, USD, etc (o null)",
  "operationCode": "código de operación o referencia visible (o null)",
  "confidence": 0.0-1.0,
  "reason": "explicación breve"
}

REGLAS DE VALIDACIÓN:
- isPaymentProof: true solo si la imagen muestra claramente una transferencia, pago o comprobante bancario
- isValid: true si es un comprobante que parece legítimo (tiene marca visible, monto, fecha o código)
- Si es una foto normal, selfie, producto, documento no relacionado → isPaymentProof: false
- Si no puedes leer bien el monto o código, indica confidence bajo pero aún puede ser isValid si parece comprobante
- Busca logos de bancos, códigos de operación, fechas, montos, nombres de destinatario`;

      const response = await axios.post(
        `${GEMINI_API_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`,
        {
          contents: [{
            parts: [
              {
                inline_data: {
                  mime_type: mimeType.split(';')[0],
                  data: base64Data
                }
              },
              { text: prompt }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 512
          }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 60000
        }
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log('[GEMINI] Voucher validation - invalid response format');
        return { 
          isValid: false, 
          isPaymentProof: false, 
          confidence: 0, 
          reason: 'Could not parse response' 
        };
      }

      const result = JSON.parse(jsonMatch[0]);
      console.log('[GEMINI] Voucher validation result:', result);

      return {
        isValid: result.isValid ?? false,
        isPaymentProof: result.isPaymentProof ?? false,
        brand: result.brand || undefined,
        amount: typeof result.amount === 'number' ? result.amount : undefined,
        currency: result.currency || undefined,
        operationCode: result.operationCode || undefined,
        confidence: result.confidence ?? 0,
        reason: result.reason || ''
      };
    } catch (error: any) {
      console.error('[GEMINI] Voucher validation failed:', error.response?.data || error.message);
      return {
        isValid: false,
        isPaymentProof: false,
        confidence: 0,
        reason: '',
        error: error.response?.data?.error?.message || error.message
      };
    }
  }
}

export const geminiService = new GeminiService();

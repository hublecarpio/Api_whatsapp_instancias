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
}

export const geminiService = new GeminiService();

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
                text: 'Transcribe this audio message exactly as spoken. Only return the transcription, nothing else. If you cannot transcribe it, return "[Audio no disponible]".'
              }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048
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
        ? `Analyze this image in the context of this conversation: "${context}". Describe what you see in detail and how it relates to the conversation.`
        : 'Describe this image in detail. What objects, people, text, or scenes do you see? Be specific and comprehensive.';

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
            maxOutputTokens: 2048
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
        ? `Analyze this video in the context of this conversation: "${context}". Describe what happens and how it relates to the conversation.`
        : 'Describe this video in detail. What happens? What objects, people, actions, or scenes do you see? Include any spoken words if audible.';

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
            maxOutputTokens: 4096
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

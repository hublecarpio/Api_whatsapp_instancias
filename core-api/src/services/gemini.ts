import axios from 'axios';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_GEMINI_MODEL = 'google/gemini-3-flash-preview';

interface GeminiResponse {
  success: boolean;
  text: string;
  error?: string;
  usedFallback?: boolean;
}

export class GeminiService {
  private apiKey: string;
  private openrouterKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || GEMINI_API_KEY || '';
    this.openrouterKey = OPENROUTER_API_KEY || '';
  }

  isConfigured(): boolean {
    return !!this.apiKey || !!this.openrouterKey;
  }

  private hasOpenRouterFallback(): boolean {
    return !!this.openrouterKey;
  }

  private isQuotaError(error: any): boolean {
    const errorMessage = error?.response?.data?.error?.message || error?.message || '';
    const errorCode = error?.response?.status;
    return (
      errorCode === 429 ||
      errorMessage.toLowerCase().includes('quota') ||
      errorMessage.toLowerCase().includes('rate') ||
      errorMessage.toLowerCase().includes('limit') ||
      errorMessage.toLowerCase().includes('exceeded')
    );
  }

  private async callOpenRouter(
    prompt: string,
    options: {
      temperature?: number;
      maxTokens?: number;
      imageBase64?: string;
      imageMimeType?: string;
    } = {}
  ): Promise<{ success: boolean; text: string; error?: string }> {
    if (!this.openrouterKey) {
      return { success: false, text: '', error: 'OpenRouter API not configured' };
    }

    try {
      console.log('[GEMINI-OPENROUTER] Using OpenRouter fallback for Gemini');
      
      const messages: any[] = [];
      
      if (options.imageBase64 && options.imageMimeType) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${options.imageMimeType};base64,${options.imageBase64}`
              }
            },
            {
              type: 'text',
              text: prompt
            }
          ]
        });
      } else {
        messages.push({
          role: 'user',
          content: prompt
        });
      }

      const response = await axios.post(
        `${OPENROUTER_API_URL}/chat/completions`,
        {
          model: OPENROUTER_GEMINI_MODEL,
          messages,
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens ?? 1024
        },
        {
          headers: {
            'Authorization': `Bearer ${this.openrouterKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://replit.com',
            'X-Title': 'WhatsApp SaaS Platform'
          },
          timeout: 120000
        }
      );

      const text = response.data?.choices?.[0]?.message?.content || '';
      console.log('[GEMINI-OPENROUTER] Response received, length:', text.length);
      
      return { success: true, text: text.trim() };
    } catch (error: any) {
      console.error('[GEMINI-OPENROUTER] OpenRouter call failed:', error.response?.data || error.message);
      return {
        success: false,
        text: '',
        error: error.response?.data?.error?.message || error.message
      };
    }
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
    availableStages: { name: string; description: string }[],
    currentStageName?: string
  ): Promise<{ success: boolean; stageName: string; confidence: number; reasoning: string; shouldChange: boolean; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, stageName: '', confidence: 0, reasoning: '', shouldChange: false, error: 'Gemini API not configured' };
    }

    if (availableStages.length === 0) {
      return { success: false, stageName: '', confidence: 0, reasoning: '', shouldChange: false, error: 'No stages configured' };
    }

    try {
      const stageNames = availableStages.map(s => s.name);
      const stagesWithDescriptions = availableStages
        .map((s, i) => `${i + 1}. "${s.name}"${s.description ? `: ${s.description}` : ''}`)
        .join('\n');
      
      const conversationText = conversationHistory
        .slice(-20)
        .map(msg => `${msg.role === 'assistant' ? 'Agente' : 'Cliente'}: ${msg.content}`)
        .join('\n');

      const currentStageContext = currentStageName 
        ? `\nETAPA ACTUAL DEL LEAD: "${currentStageName}"`
        : '\nETAPA ACTUAL DEL LEAD: Sin asignar (nuevo)';

      const prompt = `Eres un clasificador estricto de leads en un embudo de ventas. Tu trabajo es determinar en qué etapa se encuentra un lead basándote ÚNICAMENTE en las etapas definidas por el negocio.

## ETAPAS DISPONIBLES (SOLO PUEDES ELEGIR UNA DE ESTAS):
${stagesWithDescriptions}
${currentStageContext}

## CONVERSACIÓN A ANALIZAR:
${conversationText}

## INSTRUCCIONES ESTRICTAS:

1. **SOLO PUEDES RESPONDER CON UNA DE LAS ETAPAS LISTADAS ARRIBA** - No inventes etapas nuevas.

2. **CRITERIOS DE CLASIFICACIÓN** (analiza la conversación buscando estas señales):
   - Primera interacción / saludo inicial → etapa más temprana del embudo
   - Preguntas sobre productos/servicios/precios → etapa de interés/exploración
   - Solicitud de cotización o negociación → etapa intermedia
   - Confirmación de compra / envío de pago → etapa avanzada/cierre
   - Rechazo explícito / sin respuesta prolongada → etapa de pérdida (si existe)
   - Seguimiento post-venta → etapa final (si existe)

3. **DECISIÓN DE CAMBIO**: 
   - Si la etapa actual es correcta, mantén "shouldChange": false
   - Solo cambia si hay evidencia CLARA en la conversación de que el lead avanzó o retrocedió
   - Un solo mensaje no es suficiente para cambiar - busca patrones

4. **CONFIANZA**:
   - 0.9-1.0: Evidencia muy clara (ej: "quiero comprar", "ya pagué")
   - 0.7-0.89: Evidencia moderada (ej: preguntas de precio, interés)
   - 0.5-0.69: Poca evidencia, inferencia
   - <0.5: Muy incierto, mejor mantener etapa actual

## RESPONDE SOLO EN JSON:
{
  "stageName": "NOMBRE EXACTO de una etapa de la lista",
  "confidence": 0.85,
  "reasoning": "Explicación breve de por qué esta etapa",
  "shouldChange": true/false
}

IMPORTANTE: stageName DEBE ser EXACTAMENTE igual a uno de los nombres de etapa listados arriba: ${JSON.stringify(stageNames)}`;

      const response = await axios.post(
        `${GEMINI_API_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 300
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
        return { success: false, stageName: '', confidence: 0, reasoning: '', shouldChange: false, error: 'Invalid response format' };
      }

      const result = JSON.parse(jsonMatch[0]);
      
      const suggestedStage = result.stageName || '';
      const stageExists = stageNames.some(
        name => name.toLowerCase() === suggestedStage.toLowerCase()
      );
      
      if (!stageExists) {
        console.warn(`[GEMINI] Suggested stage "${suggestedStage}" not in available stages, finding closest match...`);
        
        const closestMatch = this.findClosestStage(suggestedStage, stageNames);
        if (closestMatch) {
          result.stageName = closestMatch;
          result.reasoning = `(Corregido de "${suggestedStage}") ${result.reasoning}`;
        } else {
          return { 
            success: false, 
            stageName: '', 
            confidence: 0, 
            reasoning: '', 
            shouldChange: false,
            error: `Stage "${suggestedStage}" not found in available stages` 
          };
        }
      }

      const shouldChange = currentStageName 
        ? result.stageName.toLowerCase() !== currentStageName.toLowerCase() && result.shouldChange !== false
        : true;

      console.log('[GEMINI] Lead stage analysis:', { 
        ...result, 
        shouldChange,
        currentStage: currentStageName 
      });

      return {
        success: true,
        stageName: result.stageName,
        confidence: result.confidence || 0,
        reasoning: result.reasoning || '',
        shouldChange
      };
    } catch (error: any) {
      console.error('[GEMINI] Lead stage analysis failed:', error.response?.data || error.message);
      return {
        success: false,
        stageName: '',
        confidence: 0,
        reasoning: '',
        shouldChange: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  private findClosestStage(suggested: string, available: string[]): string | null {
    const suggestedLower = suggested.toLowerCase();
    
    for (const stage of available) {
      if (stage.toLowerCase().includes(suggestedLower) || suggestedLower.includes(stage.toLowerCase())) {
        return stage;
      }
    }
    
    const keywords: Record<string, string[]> = {
      'nuevo': ['nuevo', 'new', 'inicial', 'primero', 'entrada'],
      'interesado': ['interes', 'curious', 'explorando', 'consulta'],
      'cotizando': ['cotiza', 'precio', 'quote', 'presupuesto'],
      'negociando': ['negocia', 'descuento', 'condicion'],
      'confirmado': ['confirm', 'acepta', 'si quiero', 'cierre'],
      'pagado': ['pag', 'complet', 'cerrado', 'ganado'],
      'perdido': ['perdido', 'rechaz', 'no interes', 'lost']
    };
    
    for (const stage of available) {
      const stageLower = stage.toLowerCase();
      for (const [key, synonyms] of Object.entries(keywords)) {
        if (synonyms.some(s => suggestedLower.includes(s))) {
          if (synonyms.some(s => stageLower.includes(s)) || stageLower.includes(key)) {
            return stage;
          }
        }
      }
    }
    
    return available[0];
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

  async analyzeBusinessPrompt(
    rawPrompt: string
  ): Promise<{
    success: boolean;
    config: {
      businessInfo: {
        name?: string;
        description?: string;
        industry?: string;
        country?: string;
        city?: string;
        currency?: string;
        timezone?: string;
        workingHours?: string;
        paymentMethods?: string[];
      };
      products: {
        title: string;
        description?: string;
        price: number;
        category?: string;
        variants?: string[];
      }[];
      extractionFields: {
        key: string;
        label: string;
        description?: string;
      }[];
      funnelStages: {
        name: string;
        description?: string;
        order: number;
        requiredFields?: string[];
        blockedTopics?: string[];
      }[];
      objections: {
        trigger: string;
        response: string;
        category?: string;
      }[];
      deliveryZones: {
        name: string;
        price: number;
        estimatedTime?: string;
      }[];
      agentPrompt?: string;
      agentPersonality?: string;
    };
    missing: string[];
    warnings: string[];
    confidence: number;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { 
        success: false, 
        config: { businessInfo: {}, products: [], extractionFields: [], funnelStages: [], objections: [], deliveryZones: [] },
        missing: [],
        warnings: [],
        confidence: 0,
        error: 'Gemini API not configured' 
      };
    }

    try {
      console.log('[GEMINI] Analyzing business prompt, length:', rawPrompt.length);
      
      const prompt = `Eres un experto en configurar agentes de IA para ventas por WhatsApp. Analiza el siguiente texto en bruto que describe un negocio y extrae TODA la información relevante para configurar el sistema.

## CONTEXTO DEL SISTEMA:
Este es un sistema SaaS multi-tenant donde cada negocio puede tener múltiples instancias de WhatsApp. Cada instancia tiene su propia configuración aislada de productos, campos de extracción, etapas de embudo, etc.

## ESTRUCTURA DE DATOS DEL SISTEMA:

### Tags (Etapas del Lead) vs FunnelStages (Flujo de Venta) - DIFERENCIAS CRÍTICAS:

| Concepto | Tags/Etapas del Lead | FunnelStages/Flujo de Venta |
|----------|---------------------|----------------------------|
| Propósito | Clasificación MANUAL de contactos por el usuario | Progresión AUTOMÁTICA del bot durante la venta |
| Asignación | El usuario humano asigna/cambia manualmente | El agente AI avanza automáticamente al cumplir requisitos |
| Secuencia | NO tienen orden obligatorio, son etiquetas libres | SON SECUENCIALES (Paso 1 → 2 → 3...) |
| Requisitos | No tienen campos requeridos | Cada etapa define qué datos DEBE recolectar antes de avanzar |
| Bloqueo | No bloquean conversación | Pueden BLOQUEAR temas hasta completar requisitos |
| Uso típico | CRM, organización, reportes | Control del flujo conversacional del bot |

**Ejemplos de Tags**: "Cliente VIP", "Prospecto", "Ya compró", "Lead frío", "Requiere seguimiento"
**Ejemplos de FunnelStages**: "Bienvenida" → "Calificación" → "Presentación" → "Objeciones" → "Cierre"

## TEXTO A ANALIZAR:
${rawPrompt.substring(0, 15000)}

## INSTRUCCIONES DE EXTRACCIÓN:

1. **businessInfo**: Datos generales del negocio
   - name: Nombre del negocio
   - description: Descripción corta del negocio
   - industry: Industria (ej: retail, servicios, alimentos)
   - country, city: Ubicación
   - currency: Moneda (PEN, USD, COP, etc)
   - timezone: Zona horaria
   - workingHours: Horario de atención
   - paymentMethods: Métodos de pago aceptados

2. **products**: Lista de productos/servicios (aislados por instancia)
   - title: Nombre del producto (OBLIGATORIO)
   - description: Descripción
   - price: Precio numérico (OBLIGATORIO, 0 si no se menciona)
   - category: Categoría
   - variants: Variantes (tallas, colores, tamaños)

3. **extractionFields**: Datos a extraer del cliente durante conversaciones (aislados por instancia)
   - key: Identificador único sin espacios (ej: "nombre", "direccion", "talla")
   - label: Etiqueta visible (ej: "Nombre completo", "Dirección de envío")
   - description: Para qué se usa este dato
   - isRequired: Si es obligatorio recolectarlo (true/false)

4. **funnelStages**: Etapas SECUENCIALES del embudo de ventas - EL BOT AVANZA AUTOMÁTICAMENTE (aislados por instancia)
   - name: Nombre de la etapa (ej: "Bienvenida", "Calificación", "Cierre")
   - description: Qué debe lograr el bot en esta etapa
   - order: Orden numérico SECUENCIAL (1, 2, 3...)
   - requiredFieldKeys: Array de keys de extractionFields que DEBEN recolectarse antes de avanzar
   - blockedTopics: Temas que el bot NO puede discutir hasta cumplir requisitos (ej: ["precios", "pagos", "descuentos"])
   - promptContext: Instrucciones específicas para el bot en esta etapa

5. **objections**: Manejo de objeciones comunes
   - trigger: Frase o palabra que activa la objeción
   - response: Respuesta sugerida
   - category: Categoría (precio, tiempo, confianza, etc)

6. **deliveryZones**: Zonas de envío con precios
   - name: Nombre de la zona
   - price: Precio del envío
   - estimatedTime: Tiempo estimado de entrega

7. **agentPrompt**: Prompt principal para el agente (personalidad, instrucciones generales)

8. **agentPersonality**: Resumen de la personalidad del agente (tono, estilo)

## RESPONDE EN JSON EXACTO:
{
  "config": {
    "businessInfo": {...},
    "products": [...],
    "extractionFields": [...],
    "funnelStages": [...],
    "objections": [...],
    "deliveryZones": [...],
    "agentPrompt": "...",
    "agentPersonality": "..."
  },
  "missing": ["lista de datos importantes que faltan"],
  "warnings": ["advertencias sobre datos incompletos o ambiguos"],
  "confidence": 0.85
}

REGLAS:
- Extrae TODO lo que encuentres, aunque sea parcial
- Si un producto no tiene precio claro, pon price: 0
- Si no encuentras productos, deja el array vacío
- missing debe incluir datos críticos que faltan para funcionar bien
- confidence: 0-1 basado en qué tan completa está la información`;

      let text = '';
      let usedFallback = false;

      try {
        if (this.apiKey) {
          const response = await axios.post(
            `${GEMINI_API_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`,
            {
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 8192
              }
            },
            {
              headers: { 'Content-Type': 'application/json' },
              timeout: 120000
            }
          );
          text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } else {
          throw new Error('No Gemini API key, trying fallback');
        }
      } catch (directError: any) {
        console.warn('[GEMINI] Direct API failed:', directError.response?.data?.error?.message || directError.message);
        
        if (this.hasOpenRouterFallback() && (this.isQuotaError(directError) || !this.apiKey)) {
          console.log('[GEMINI] Attempting OpenRouter fallback for business prompt analysis...');
          const fallbackResult = await this.callOpenRouter(prompt, {
            temperature: 0.2,
            maxTokens: 8192
          });
          
          if (fallbackResult.success) {
            text = fallbackResult.text;
            usedFallback = true;
            console.log('[GEMINI] OpenRouter fallback succeeded');
          } else {
            throw new Error(fallbackResult.error || 'OpenRouter fallback failed');
          }
        } else {
          throw directError;
        }
      }
      
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log('[GEMINI] Business prompt analysis - invalid response format');
        return { 
          success: false, 
          config: { businessInfo: {}, products: [], extractionFields: [], funnelStages: [], objections: [], deliveryZones: [] },
          missing: ['No se pudo analizar el prompt'],
          warnings: [],
          confidence: 0,
          error: 'Invalid response format from Gemini'
        };
      }

      const result = JSON.parse(jsonMatch[0]);
      console.log('[GEMINI] Business prompt analysis completed:', {
        products: result.config?.products?.length || 0,
        extractionFields: result.config?.extractionFields?.length || 0,
        funnelStages: result.config?.funnelStages?.length || 0,
        objections: result.config?.objections?.length || 0,
        missing: result.missing?.length || 0,
        confidence: result.confidence,
        usedFallback
      });

      return {
        success: true,
        config: {
          businessInfo: result.config?.businessInfo || {},
          products: result.config?.products || [],
          extractionFields: result.config?.extractionFields || [],
          funnelStages: result.config?.funnelStages || [],
          objections: result.config?.objections || [],
          deliveryZones: result.config?.deliveryZones || [],
          agentPrompt: result.config?.agentPrompt,
          agentPersonality: result.config?.agentPersonality
        },
        missing: result.missing || [],
        warnings: usedFallback ? [...(result.warnings || []), 'Se usó OpenRouter como respaldo por límites de cuota'] : (result.warnings || []),
        confidence: result.confidence || 0
      };
    } catch (error: any) {
      console.error('[GEMINI] Business prompt analysis failed:', error.response?.data || error.message);
      return {
        success: false,
        config: { businessInfo: {}, products: [], extractionFields: [], funnelStages: [], objections: [], deliveryZones: [] },
        missing: [],
        warnings: [],
        confidence: 0,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }
}

export const geminiService = new GeminiService();

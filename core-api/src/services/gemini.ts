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

  // ========== GENERATE MASTER PROMPT + SECTIONS ==========
  
  async generateMasterPromptAndSections(
    rawPrompt: string
  ): Promise<{
    success: boolean;
    masterPrompt: string;
    sections: Array<{
      type: 'CORE' | 'TONE' | 'SALES' | 'POLICIES' | 'FAQ' | 'OBJECTIONS' | 'CLOSING' | 'OTHER';
      title: string;
      content: string;
      isCore: boolean;
      priority: number;
      keywords: string[];
    }>;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { success: false, masterPrompt: '', sections: [], error: 'Gemini API not configured' };
    }

    try {
      console.log('[GEMINI] Generating master prompt and sections, length:', rawPrompt.length);
      
      const prompt = `Eres un experto en estructurar prompts para agentes de IA de ventas. Analiza el siguiente texto de configuración de negocio y genera DOS COSAS:

1. **PROMPT MAESTRO (raíz)**: Un prompt conciso que contiene SOLO el contexto ESENCIAL:
   - IDENTIDAD: Nombre del vendedor, empresa, país, descripción breve
   - OBJETIVO PRINCIPAL: Meta de la conversación (ej: cerrar pedido con X datos)
   - REGLAS CRÍTICAS: Reglas que NUNCA deben violarse (ej: no mencionar precios sin X datos)
   - TONO/PERSONALIDAD: Estilo de comunicación en 1-2 líneas
   - NO incluir FAQs, flujos detallados, objeciones específicas, etc. (eso va en secciones)

2. **SECCIONES (ramas)**: Contenido especializado dividido en categorías:
   - CORE: Instrucciones fundamentales adicionales
   - TONE: Detalles de personalidad, emojis, formato
   - POLICIES: Políticas de envío, pagos, devoluciones, palabras prohibidas
   - FAQ: Preguntas frecuentes con sus respuestas exactas
   - OBJECTIONS: Manejo de objeciones específicas
   - SALES: Flujo operativo, técnicas de venta, argumentos
   - CLOSING: Mensajes de cierre, confirmaciones, derivación
   - OTHER: Información que no encaja en otras categorías

## TEXTO A ANALIZAR:
${rawPrompt.substring(0, 25000)}

## RESPONDE EN JSON:
{
  "masterPrompt": "Prompt maestro conciso con identidad, objetivo, reglas críticas y tono...",
  "sections": [
    {
      "type": "FAQ",
      "title": "Preguntas sobre Envíos",
      "content": "Contenido completo con las FAQs sobre envíos...",
      "isCore": false,
      "priority": 7,
      "keywords": ["envio", "entrega", "shalom", "demora"]
    },
    {
      "type": "POLICIES",
      "title": "Métodos de Pago",
      "content": "Yape, Plin, contra entrega con adelanto mínimo del 50%...",
      "isCore": false,
      "priority": 8,
      "keywords": ["pago", "yape", "plin", "adelanto"]
    }
  ]
}

REGLAS CRÍTICAS:
- El masterPrompt debe ser CONCISO (máx 600 palabras) pero COMPLETO en identidad/objetivo/reglas/tono
- Las secciones deben contener TODO el contenido especializado del texto original
- Las FAQs deben preservar las respuestas EXACTAS del texto
- Cada sección debe tener keywords relevantes para búsqueda semántica
- priority: CORE=10, TONE=9, POLICIES=8, FAQ=7, SALES=6, OBJECTIONS=5, CLOSING=4, OTHER=3
- isCore: true solo para CORE y TONE`;

      let text = '';
      
      if (this.apiKey) {
        const response = await axios.post(
          `${GEMINI_API_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`,
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.15, maxOutputTokens: 16000 }
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 180000 }
        );
        text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } else if (this.hasOpenRouterFallback()) {
        const result = await this.callOpenRouter(prompt, { temperature: 0.15, maxTokens: 16000 });
        if (result.success) {
          text = result.text;
        } else {
          throw new Error(result.error || 'OpenRouter failed');
        }
      } else {
        throw new Error('No AI provider configured');
      }
      
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('[GEMINI] Invalid response format for master prompt generation');
        return { success: false, masterPrompt: '', sections: [], error: 'Invalid response format' };
      }

      const result = JSON.parse(jsonMatch[0]);
      
      console.log('[GEMINI] Generated master prompt and sections:', {
        masterPromptLength: result.masterPrompt?.length || 0,
        sectionsCount: result.sections?.length || 0,
        sectionTypes: result.sections?.map((s: any) => s.type) || []
      });

      return {
        success: true,
        masterPrompt: result.masterPrompt || '',
        sections: (result.sections || []).map((s: any) => ({
          type: s.type || 'OTHER',
          title: s.title || 'Sin título',
          content: s.content || '',
          isCore: s.isCore ?? (s.type === 'CORE' || s.type === 'TONE'),
          priority: s.priority ?? 5,
          keywords: s.keywords || []
        }))
      };
    } catch (error: any) {
      console.error('[GEMINI] Generate master prompt failed:', error.response?.data || error.message);
      return {
        success: false,
        masterPrompt: '',
        sections: [],
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  // ========== MULTI-PASS PROMPT IMPORTER ==========
  
  private chunkText(text: string, chunkSize: number = 6000, overlap: number = 900): { chunk: string; index: number; start: number; end: number }[] {
    const chunks: { chunk: string; index: number; start: number; end: number }[] = [];
    let start = 0;
    let index = 0;
    let prevStart = -1;
    
    while (start < text.length) {
      // Prevent infinite loop
      if (start === prevStart) {
        start = prevStart + 1;
      }
      prevStart = start;
      
      const end = Math.min(start + chunkSize, text.length);
      let chunkEnd = end;
      
      // Try to break at paragraph or sentence boundary
      if (end < text.length) {
        const paragraphBreak = text.lastIndexOf('\n\n', end);
        const sentenceBreak = text.lastIndexOf('. ', end);
        if (paragraphBreak > start + chunkSize * 0.7) {
          chunkEnd = paragraphBreak + 2;
        } else if (sentenceBreak > start + chunkSize * 0.7) {
          chunkEnd = sentenceBreak + 2;
        }
      }
      
      chunks.push({
        chunk: text.substring(start, chunkEnd),
        index,
        start,
        end: chunkEnd
      });
      
      // Exit if we've reached the end
      if (chunkEnd >= text.length) break;
      
      // Calculate next start with protection against going backwards
      const nextStart = chunkEnd - overlap;
      start = Math.max(nextStart, prevStart + 1);
      index++;
      
      // Safety limit to prevent runaway loops
      if (index > 100) {
        console.warn('[CHUNK] Safety limit reached, stopping at 100 chunks');
        break;
      }
    }
    
    console.log(`[CHUNK] Split ${text.length} chars into ${chunks.length} chunks`);
    return chunks;
  }

  private async extractCategory(
    chunk: string,
    category: 'CORE' | 'TONE' | 'POLICIES' | 'FAQ' | 'OBJECTIONS' | 'SALES' | 'CLOSING',
    chunkIndex: number
  ): Promise<{
    sections: Array<{
      type: string;
      title: string;
      content: string;
      isCore: boolean;
      priority: number;
      keywords: string[];
      confidence: number;
      evidence: string;
      chunkIndex: number;
    }>;
  }> {
    const categoryPrompts: Record<string, { description: string; isCore: boolean; priority: number }> = {
      'CORE': { 
        description: 'Información fundamental: nombre del negocio, qué hace/vende, propósito, misión, ubicación principal',
        isCore: true, 
        priority: 10 
      },
      'TONE': { 
        description: 'Personalidad y estilo de comunicación: formal/informal, uso de emojis, cómo saludar, cómo despedirse',
        isCore: true, 
        priority: 9 
      },
      'POLICIES': { 
        description: 'Políticas del negocio: envíos, tiempos de entrega, devoluciones, garantías, horarios de atención, formas de pago',
        isCore: false, 
        priority: 8 
      },
      'FAQ': { 
        description: 'Preguntas frecuentes y sus respuestas: dudas comunes de clientes sobre productos, servicios, procesos',
        isCore: false, 
        priority: 7 
      },
      'OBJECTIONS': { 
        description: 'Objeciones de clientes y cómo manejarlas: "es muy caro", "lo pienso", "no tengo tiempo", "no confío"',
        isCore: false, 
        priority: 7 
      },
      'SALES': { 
        description: 'Argumentos de venta, beneficios, propuesta de valor, diferenciadores, por qué elegir este negocio',
        isCore: false, 
        priority: 6 
      },
      'CLOSING': { 
        description: 'Técnicas de cierre: urgencia, escasez, llamados a acción, cómo pedir la venta, promociones',
        isCore: false, 
        priority: 5 
      }
    };

    const config = categoryPrompts[category];
    
    const prompt = `Extrae SOLO información de la categoría "${category}" de este texto.

## CATEGORÍA: ${category}
${config.description}

## TEXTO (chunk ${chunkIndex + 1}):
${chunk}

## INSTRUCCIONES:
1. Extrae SOLO lo relevante para ${category}, ignora todo lo demás
2. Cada sección debe ser AUTO-CONTENIDA (entendible sin contexto adicional)
3. Máximo 400 palabras por sección
4. Incluye una CITA TEXTUAL breve como evidencia (max 50 chars)
5. Si NO hay información de ${category} en este texto, devuelve sections: []

## RESPONDE EN JSON:
{
  "sections": [
    {
      "title": "Título descriptivo",
      "content": "Contenido completo y auto-contenido...",
      "keywords": ["palabra1", "palabra2", "palabra3"],
      "confidence": 0.95,
      "evidence": "cita textual del original..."
    }
  ]
}`;

    // Retry logic with exponential backoff for rate limits
    const maxRetries = 3;
    let lastError: any;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let text = '';
        
        if (this.apiKey) {
          const response = await axios.post(
            `${GEMINI_API_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`,
            {
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
          );
          text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } else if (this.hasOpenRouterFallback()) {
          const result = await this.callOpenRouter(prompt, { temperature: 0.1, maxTokens: 2048 });
          text = result.success ? result.text : '';
        }
        
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { sections: [] };
        
        const result = JSON.parse(jsonMatch[0]);
        
        return {
          sections: (result.sections || []).map((s: any) => ({
            type: category,
            title: s.title || 'Sin título',
            content: s.content || '',
            isCore: config.isCore,
            priority: config.priority,
            keywords: s.keywords || [],
            confidence: s.confidence || 0.5,
            evidence: s.evidence || '',
            chunkIndex
          }))
        };
      } catch (error: any) {
        lastError = error;
        const isRateLimited = this.isQuotaError(error);
        
        if (isRateLimited && attempt < maxRetries) {
          const delay = 1000 * Math.pow(2, attempt) + Math.random() * 500;
          console.warn(`[GEMINI] ${category} rate limited, retrying in ${delay}ms (attempt ${attempt + 1})`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          console.error(`[GEMINI] Extract ${category} failed:`, error.message);
          return { sections: [] };
        }
      }
    }
    
    console.error(`[GEMINI] Extract ${category} failed after retries:`, lastError?.message);
    return { sections: [] };
  }

  private async extractStructuredData(
    rawPrompt: string
  ): Promise<{
    products: Array<{ name: string; price?: number; currency?: string; description?: string; confidence: number }>;
    deliveryZones: Array<{ name: string; price?: number; minOrder?: number; estimatedTime?: string; confidence: number }>;
    extractionFields: Array<{ name: string; type: string; required: boolean; confidence: number }>;
    businessHours: Array<{ day: string; open: string; close: string }>;
    contactInfo: { phone?: string; email?: string; address?: string; whatsapp?: string };
  }> {
    const prompt = `Extrae DATOS ESTRUCTURADOS de este texto de negocio. Solo extrae lo que está EXPLÍCITAMENTE mencionado.

## TEXTO:
${rawPrompt.substring(0, 12000)}

## EXTRAE:
1. **PRODUCTOS**: Nombre, precio, descripción
2. **ZONAS DE ENTREGA**: Nombre de zona, costo de envío, mínimo de compra, tiempo estimado
3. **CAMPOS A PEDIR AL CLIENTE**: Qué datos necesitan (nombre, dirección, teléfono, etc)
4. **HORARIOS**: Días y horas de atención
5. **CONTACTO**: Teléfono, email, dirección física, WhatsApp

## RESPONDE EN JSON:
{
  "products": [
    {"name": "Producto X", "price": 29.99, "currency": "USD", "description": "...", "confidence": 0.9}
  ],
  "deliveryZones": [
    {"name": "Centro", "price": 5, "minOrder": 20, "estimatedTime": "30-45 min", "confidence": 0.85}
  ],
  "extractionFields": [
    {"name": "nombre", "type": "text", "required": true, "confidence": 0.95},
    {"name": "direccion", "type": "address", "required": true, "confidence": 0.9}
  ],
  "businessHours": [
    {"day": "Lunes-Viernes", "open": "09:00", "close": "18:00"}
  ],
  "contactInfo": {
    "phone": "+51999999999",
    "email": "contacto@negocio.com",
    "address": "Av. Principal 123",
    "whatsapp": "+51999999999"
  }
}

REGLAS:
- Solo incluye datos que estén CLARAMENTE en el texto
- confidence: 0.9+ si está explícito, 0.7-0.89 si es inferido, <0.7 si es dudoso
- Si no hay datos de una categoría, devuelve array vacío o null`;

    try {
      let text = '';
      
      if (this.apiKey) {
        const response = await axios.post(
          `${GEMINI_API_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`,
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 90000 }
        );
        text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } else if (this.hasOpenRouterFallback()) {
        const result = await this.callOpenRouter(prompt, { temperature: 0.1, maxTokens: 4096 });
        text = result.success ? result.text : '';
      }
      
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { products: [], deliveryZones: [], extractionFields: [], businessHours: [], contactInfo: {} };
      }
      
      const result = JSON.parse(jsonMatch[0]);
      console.log('[GEMINI] Extracted structured data:', {
        products: result.products?.length || 0,
        zones: result.deliveryZones?.length || 0,
        fields: result.extractionFields?.length || 0
      });
      
      return {
        products: result.products || [],
        deliveryZones: result.deliveryZones || [],
        extractionFields: result.extractionFields || [],
        businessHours: result.businessHours || [],
        contactInfo: result.contactInfo || {}
      };
    } catch (error: any) {
      console.error('[GEMINI] Extract structured data failed:', error.message);
      return { products: [], deliveryZones: [], extractionFields: [], businessHours: [], contactInfo: {} };
    }
  }

  // Helper for retrying API calls with exponential backoff
  private async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        const isRateLimited = this.isQuotaError(error);
        
        if (isRateLimited && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
          console.warn(`[GEMINI] Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, delay));
        } else if (!isRateLimited) {
          throw error; // Non-rate-limit errors fail immediately
        }
      }
    }
    throw lastError;
  }

  // Process structured data from all chunks for large texts
  private async extractStructuredDataFromChunks(
    chunks: string[]
  ): Promise<{
    products: Array<{ name: string; price?: number; currency?: string; description?: string; confidence: number }>;
    deliveryZones: Array<{ name: string; price?: number; minOrder?: number; estimatedTime?: string; confidence: number }>;
    extractionFields: Array<{ name: string; type: string; required: boolean; confidence: number }>;
    businessHours: Array<{ day: string; open: string; close: string }>;
    contactInfo: { phone?: string; email?: string; address?: string; whatsapp?: string };
  }> {
    // For small texts (1 chunk), use the standard method
    if (chunks.length <= 1) {
      return this.extractStructuredData(chunks[0] || '');
    }
    
    // For large texts, process ALL chunks sequentially with rate limiting
    console.log(`[GEMINI] Extracting structured data from ${chunks.length} chunks`);
    
    const allProducts: Array<{ name: string; price?: number; currency?: string; description?: string; confidence: number }> = [];
    const allZones: Array<{ name: string; price?: number; minOrder?: number; estimatedTime?: string; confidence: number }> = [];
    const allFields: Array<{ name: string; type: string; required: boolean; confidence: number }> = [];
    const allHours: Array<{ day: string; open: string; close: string }> = [];
    let contactInfo: { phone?: string; email?: string; address?: string; whatsapp?: string } = {};
    
    // Process ALL chunks (max 10) to ensure complete coverage
    const maxChunks = Math.min(chunks.length, 10);
    const chunksToProcess = chunks.slice(0, maxChunks);
    
    for (let i = 0; i < chunksToProcess.length; i++) {
      const chunk = chunksToProcess[i];
      try {
        // Use retry with backoff for rate limit safety
        const result = await this.withRetry(() => this.extractStructuredData(chunk));
        
        // Merge products (dedupe by name)
        for (const product of result.products) {
          if (!allProducts.some(p => p.name.toLowerCase() === product.name.toLowerCase())) {
            allProducts.push(product);
          }
        }
        
        // Merge zones (dedupe by name)
        for (const zone of result.deliveryZones) {
          if (!allZones.some(z => z.name.toLowerCase() === zone.name.toLowerCase())) {
            allZones.push(zone);
          }
        }
        
        // Merge fields (dedupe by name)
        for (const field of result.extractionFields) {
          if (!allFields.some(f => f.name.toLowerCase() === field.name.toLowerCase())) {
            allFields.push(field);
          }
        }
        
        // Merge hours (dedupe by day)
        for (const hours of result.businessHours) {
          if (!allHours.some(h => h.day.toLowerCase() === hours.day.toLowerCase())) {
            allHours.push(hours);
          }
        }
        
        // Merge contact info (prefer non-empty values)
        if (result.contactInfo) {
          contactInfo = {
            phone: contactInfo.phone || result.contactInfo.phone,
            email: contactInfo.email || result.contactInfo.email,
            address: contactInfo.address || result.contactInfo.address,
            whatsapp: contactInfo.whatsapp || result.contactInfo.whatsapp
          };
        }
        
        // Delay between chunks to avoid rate limits
        if (i < chunksToProcess.length - 1) {
          await new Promise(r => setTimeout(r, 800));
        }
      } catch (err) {
        console.error(`[GEMINI] Chunk ${i} structured extraction failed:`, err);
        // Continue with other chunks even if one fails
      }
    }
    
    console.log(`[GEMINI] Merged structured data from ${chunksToProcess.length} chunks:`, {
      products: allProducts.length,
      zones: allZones.length,
      fields: allFields.length
    });
    
    return {
      products: allProducts,
      deliveryZones: allZones,
      extractionFields: allFields,
      businessHours: allHours,
      contactInfo
    };
  }

  private mergeSections(
    allSections: Array<{
      type: string;
      title: string;
      content: string;
      isCore: boolean;
      priority: number;
      keywords: string[];
      confidence: number;
      evidence: string;
      chunkIndex: number;
    }>
  ): Array<{
    type: string;
    title: string;
    content: string;
    isCore: boolean;
    priority: number;
    keywords: string[];
    confidence: number;
    evidence: string;
    needsReview: boolean;
  }> {
    const merged: Map<string, typeof allSections[0] & { needsReview: boolean }> = new Map();
    
    for (const section of allSections) {
      const key = `${section.type}:${section.title.toLowerCase().trim()}`;
      
      if (!merged.has(key)) {
        merged.set(key, { ...section, needsReview: section.confidence < 0.7 });
      } else {
        const existing = merged.get(key)!;
        // Keep higher confidence version, merge keywords
        if (section.confidence > existing.confidence) {
          merged.set(key, {
            ...section,
            keywords: [...new Set([...existing.keywords, ...section.keywords])],
            needsReview: section.confidence < 0.7
          });
        } else {
          existing.keywords = [...new Set([...existing.keywords, ...section.keywords])];
        }
      }
    }
    
    // Also check for similar content across different titles
    const results = Array.from(merged.values());
    
    // Sort by priority and confidence
    results.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.confidence - a.confidence;
    });
    
    console.log(`[MERGE] Merged ${allSections.length} sections into ${results.length} unique sections`);
    
    return results.map(({ chunkIndex, ...rest }) => rest);
  }

  async parsePromptToSectionsV2(
    rawPrompt: string
  ): Promise<{
    success: boolean;
    masterPrompt: string;
    sections: Array<{
      type: string;
      title: string;
      content: string;
      isCore: boolean;
      priority: number;
      keywords: string[];
      confidence: number;
      evidence: string;
      needsReview: boolean;
    }>;
    structuredData: {
      products: Array<{ name: string; price?: number; currency?: string; description?: string; confidence: number }>;
      deliveryZones: Array<{ name: string; price?: number; minOrder?: number; estimatedTime?: string; confidence: number }>;
      extractionFields: Array<{ name: string; type: string; required: boolean; confidence: number }>;
      businessHours: Array<{ day: string; open: string; close: string }>;
      contactInfo: { phone?: string; email?: string; address?: string; whatsapp?: string };
    };
    missingCategories: string[];
    stats: { totalChunks: number; totalSections: number; avgConfidence: number };
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { 
        success: false,
        masterPrompt: '',
        sections: [],
        structuredData: { products: [], deliveryZones: [], extractionFields: [], businessHours: [], contactInfo: {} },
        missingCategories: [],
        stats: { totalChunks: 0, totalSections: 0, avgConfidence: 0 },
        error: 'Gemini API not configured' 
      };
    }

    console.log(`[GEMINI-V2] Starting multi-pass extraction, text length: ${rawPrompt.length}`);
    
    // Helper for rate-limited sequential execution with delay
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
    const RATE_LIMIT_DELAY = 500; // 500ms between API calls
    
    try {
      // Step 1: Chunk the text if needed
      const chunks = rawPrompt.length > 8000 
        ? this.chunkText(rawPrompt, 6000, 900)
        : [{ chunk: rawPrompt, index: 0, start: 0, end: rawPrompt.length }];
      
      // Step 2: Extract structured data from ALL chunks (not just first 12k)
      // For large texts, process each chunk and merge results
      const structuredDataPromise = this.extractStructuredDataFromChunks(chunks.map(c => c.chunk));
      
      // Step 3: Extract categories with rate limiting (max 2 parallel calls at a time)
      const categories: Array<'CORE' | 'TONE' | 'POLICIES' | 'FAQ' | 'OBJECTIONS' | 'SALES' | 'CLOSING'> = 
        ['CORE', 'TONE', 'POLICIES', 'FAQ', 'OBJECTIONS', 'SALES', 'CLOSING'];
      
      const allSections: Array<any> = [];
      
      // Process chunks sequentially, categories in small batches (max 2 parallel)
      for (const chunk of chunks) {
        // Batch 1: CORE and TONE (priority 1)
        const [coreResult, toneResult] = await Promise.all([
          this.extractCategory(chunk.chunk, 'CORE', chunk.index),
          this.extractCategory(chunk.chunk, 'TONE', chunk.index)
        ]);
        allSections.push(...coreResult.sections, ...toneResult.sections);
        await delay(RATE_LIMIT_DELAY);
        
        // Batch 2: POLICIES and FAQ
        const [policiesResult, faqResult] = await Promise.all([
          this.extractCategory(chunk.chunk, 'POLICIES', chunk.index),
          this.extractCategory(chunk.chunk, 'FAQ', chunk.index)
        ]);
        allSections.push(...policiesResult.sections, ...faqResult.sections);
        await delay(RATE_LIMIT_DELAY);
        
        // Batch 3: OBJECTIONS and SALES
        const [objectionsResult, salesResult] = await Promise.all([
          this.extractCategory(chunk.chunk, 'OBJECTIONS', chunk.index),
          this.extractCategory(chunk.chunk, 'SALES', chunk.index)
        ]);
        allSections.push(...objectionsResult.sections, ...salesResult.sections);
        await delay(RATE_LIMIT_DELAY);
        
        // Batch 4: CLOSING (single)
        const closingResult = await this.extractCategory(chunk.chunk, 'CLOSING', chunk.index);
        allSections.push(...closingResult.sections);
        
        // Delay before next chunk
        if (chunks.indexOf(chunk) < chunks.length - 1) {
          await delay(RATE_LIMIT_DELAY);
        }
      }
      
      // Step 4: Merge and deduplicate
      const mergedSections = this.mergeSections(allSections);
      
      // Step 5: Get structured data result
      const structuredData = await structuredDataPromise;
      
      // Step 6: Generate Master Prompt (essential context for all conversations)
      await delay(RATE_LIMIT_DELAY);
      const masterPrompt = await this.generateMasterPrompt(rawPrompt);
      
      // Step 7: Identify missing categories
      const foundTypes = new Set(mergedSections.map(s => s.type));
      const missingCategories = categories.filter(c => !foundTypes.has(c));
      
      // Calculate stats
      const avgConfidence = mergedSections.length > 0
        ? mergedSections.reduce((sum, s) => sum + s.confidence, 0) / mergedSections.length
        : 0;
      
      console.log(`[GEMINI-V2] Extraction complete:`, {
        chunks: chunks.length,
        sections: mergedSections.length,
        masterPromptLength: masterPrompt.length,
        structured: {
          products: structuredData.products.length,
          zones: structuredData.deliveryZones.length,
          fields: structuredData.extractionFields.length
        },
        missing: missingCategories,
        avgConfidence: avgConfidence.toFixed(2)
      });
      
      return {
        success: true,
        masterPrompt,
        sections: mergedSections,
        structuredData,
        missingCategories,
        stats: {
          totalChunks: chunks.length,
          totalSections: mergedSections.length,
          avgConfidence
        }
      };
    } catch (error: any) {
      console.error('[GEMINI-V2] Multi-pass extraction failed:', error.message);
      return {
        success: false,
        masterPrompt: '',
        sections: [],
        structuredData: { products: [], deliveryZones: [], extractionFields: [], businessHours: [], contactInfo: {} },
        missingCategories: [],
        stats: { totalChunks: 0, totalSections: 0, avgConfidence: 0 },
        error: error.message
      };
    }
  }

  // Legacy method - kept for backward compatibility
  async parsePromptToSections(
    rawPrompt: string
  ): Promise<{
    success: boolean;
    sections: {
      type: 'CORE' | 'TONE' | 'SALES' | 'POLICIES' | 'FAQ' | 'OBJECTIONS' | 'CLOSING' | 'OTHER';
      title: string;
      content: string;
      isCore: boolean;
      priority: number;
      keywords: string[];
    }[];
    missingCategories: string[];
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { 
        success: false, 
        sections: [],
        missingCategories: [],
        error: 'Gemini API not configured' 
      };
    }

    try {
      console.log('[GEMINI] Parsing prompt to RAG sections (legacy), length:', rawPrompt.length);
      
      const prompt = `Eres un experto en estructurar conocimiento para sistemas RAG (Retrieval Augmented Generation). Tu tarea es dividir el siguiente texto de contexto de negocio en SECCIONES ESTRUCTURADAS que puedan ser consultadas de forma independiente.

## TEXTO A ANALIZAR:
${rawPrompt.substring(0, 15000)}

## CATEGORÍAS DE SECCIONES (usa estas exactamente):
- **CORE**: Información fundamental del negocio (nombre, qué hace, propósito) - SIEMPRE se incluye
- **TONE**: Personalidad, tono de voz, estilo de comunicación del agente
- **SALES**: Técnicas de venta, argumentos, propuesta de valor
- **POLICIES**: Políticas de envío, devoluciones, garantías, horarios
- **FAQ**: Preguntas frecuentes y sus respuestas
- **OBJECTIONS**: Manejo de objeciones comunes (precio, tiempo, confianza)
- **CLOSING**: Técnicas de cierre, llamados a acción, urgencia
- **OTHER**: Información adicional que no encaja en otras categorías

## REGLAS DE DIVISIÓN:
1. Cada sección debe ser AUTO-CONTENIDA (no depender de otras para entenderse)
2. Máximo 500 palabras por sección (si es más largo, divídelo)
3. Incluye 3-5 palabras clave por sección para búsqueda
4. CORE e información esencial van con isCore: true, priority: 10
5. Información de consulta frecuente: priority: 7-9
6. Información específica/detallada: priority: 3-6
7. NO inventes información, solo estructura lo que está en el texto

## RESPONDE EN JSON:
{
  "sections": [
    {
      "type": "CORE",
      "title": "Sobre [Nombre del Negocio]",
      "content": "Texto auto-contenido de la sección...",
      "isCore": true,
      "priority": 10,
      "keywords": ["palabra1", "palabra2", "palabra3"]
    },
    {
      "type": "POLICIES",
      "title": "Política de Envíos",
      "content": "Texto de la política...",
      "isCore": false,
      "priority": 7,
      "keywords": ["envío", "delivery", "zonas"]
    }
  ],
  "missingCategories": ["FAQ", "OBJECTIONS"]
}

IMPORTANTE:
- Genera al menos una sección CORE siempre
- missingCategories lista categorías donde NO encontraste información (el negocio debería agregarla)
- Cada sección debe tener sentido de forma aislada`;

      let text = '';

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
          throw new Error('No Gemini API key');
        }
      } catch (directError: any) {
        if (this.hasOpenRouterFallback()) {
          const fallbackResult = await this.callOpenRouter(prompt, {
            temperature: 0.2,
            maxTokens: 8192
          });
          if (fallbackResult.success) {
            text = fallbackResult.text;
          } else {
            throw new Error(fallbackResult.error || 'Fallback failed');
          }
        } else {
          throw directError;
        }
      }
      
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { 
          success: false, 
          sections: [],
          missingCategories: [],
          error: 'Invalid response format'
        };
      }

      const result = JSON.parse(jsonMatch[0]);
      console.log('[GEMINI] Parsed prompt into sections:', {
        count: result.sections?.length || 0,
        types: result.sections?.map((s: any) => s.type) || [],
        missing: result.missingCategories || []
      });

      return {
        success: true,
        sections: result.sections || [],
        missingCategories: result.missingCategories || []
      };
    } catch (error: any) {
      console.error('[GEMINI] Parse prompt to sections failed:', error.message);
      return {
        success: false,
        sections: [],
        missingCategories: [],
        error: error.message
      };
    }
  }

  async suggestMissingContent(
    category: string,
    existingSections: { title: string; content: string }[],
    businessInfo?: { name?: string; industry?: string }
  ): Promise<{
    success: boolean;
    suggestions: string[];
    sampleContent?: string;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { success: false, suggestions: [], error: 'Gemini API not configured' };
    }

    try {
      const existingContext = existingSections.length > 0
        ? `Contexto existente del negocio:\n${existingSections.map(s => `- ${s.title}`).join('\n')}`
        : 'No hay secciones existentes.';

      const businessContext = businessInfo?.name
        ? `Negocio: ${businessInfo.name}${businessInfo.industry ? ` (${businessInfo.industry})` : ''}`
        : 'Negocio sin identificar';

      const prompt = `Eres un consultor de negocios ayudando a completar la base de conocimiento de un chatbot de ventas.

${businessContext}
${existingContext}

La categoría "${category}" está VACÍA. Necesitas sugerir qué información debería incluir.

## CATEGORÍAS Y SU PROPÓSITO:
- CORE: Información fundamental (qué hace el negocio, misión)
- TONE: Cómo debe hablar el bot (formal/informal, emojis, etc)
- SALES: Argumentos de venta, beneficios, propuesta de valor
- POLICIES: Envíos, devoluciones, garantías, horarios
- FAQ: Preguntas frecuentes de clientes
- OBJECTIONS: Respuestas a objeciones ("es muy caro", "lo pienso")
- CLOSING: Técnicas para cerrar ventas, urgencia

Responde en JSON:
{
  "suggestions": [
    "¿Cuál es el tiempo de entrega?",
    "¿Cuál es la política de devoluciones?",
    "..."
  ],
  "sampleContent": "Ejemplo de texto que podrían agregar para esta categoría..."
}`;

      const response = await axios.post(
        `${GEMINI_API_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        }
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { success: false, suggestions: [], error: 'Invalid response' };
      }

      const result = JSON.parse(jsonMatch[0]);
      return {
        success: true,
        suggestions: result.suggestions || [],
        sampleContent: result.sampleContent
      };
    } catch (error: any) {
      return { success: false, suggestions: [], error: error.message };
    }
  }
}

export const geminiService = new GeminiService();

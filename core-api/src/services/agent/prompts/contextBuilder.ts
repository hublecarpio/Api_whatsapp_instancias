import prisma from '../../prisma.js';
import { retrieveRelevantSections, formatSectionsForPrompt } from '../../ragService.js';
import { replacePromptVariables } from '../../promptVariables.js';
import { ChatMessage } from '../core/types.js';

const MEMORY_RECENT_FULL = 5;
const MEMORY_OLDER_TRUNCATE = 150;
const MEMORY_MAX_MESSAGES = 30;

export interface BusinessContext {
  business: any;
  instanceId: string | null;
  products: any[];
  deliveryZones: any[];
  extractionFields: any[];
  funnelStages: any[];
  promptConfig: any;
  agentFiles: any[];
  currencySymbol: string;
  currencyCode: string;
  businessObjective: 'SALES' | 'APPOINTMENTS';
  hasAppointments: boolean;
}

export interface ConversationContext {
  contactPhone: string;
  contactName: string;
  messages: ChatMessage[];
  existingOrder: any | null;
  extractedData: Record<string, any>;
  funnelStatus: any | null;
  contact: any | null;
  assignment: any | null;
}

export interface TriggerContext {
  autoTriggerResult?: any;
  mediaAnalysis?: string;
  voucherInfo?: any;
  geminiVoucherResult?: {
    isValid: boolean;
    isPaymentProof: boolean;
    brand?: string;
    amount?: number;
    currency?: string;
    operationCode?: string;
    confidence: number;
    reason: string;
    imageUrl?: string;
  };
}

export interface BuiltContext {
  systemPrompt: string;
  conversationMessages: { role: 'user' | 'assistant'; content: string }[];
  allowedTools: string[];
  metadata: {
    tokensEstimate: number;
    ragSectionsUsed: number;
    coreSectionsUsed: number;
    productsIncluded: number;
    zonesIncluded: number;
    currentStage: string | null;
    blockedTopics: string[];
    allowedToolNames: string[];
  };
}

export class ContextBuilder {
  private businessContext: BusinessContext;
  private conversationContext: ConversationContext;
  private triggerContext: TriggerContext;

  constructor(
    businessContext: BusinessContext,
    conversationContext: ConversationContext,
    triggerContext: TriggerContext = {}
  ) {
    this.businessContext = businessContext;
    this.conversationContext = conversationContext;
    this.triggerContext = triggerContext;
  }

  async build(): Promise<BuiltContext> {
    const funnelStatus = this.conversationContext.funnelStatus;
    const currentStage = funnelStatus?.currentStage || null;
    const blockedTopics: string[] = currentStage?.blockedTopics || [];
    const allowedTools: string[] = currentStage?.toolsAllowed || [];
    
    const sections: string[] = [];
    let ragSectionsUsed = 0;

    // BLOQUE 1: IDENTIDAD (prioridad máxima - siempre primero)
    sections.push(await this.buildCoreIdentity());

    // BLOQUE 2: REGLAS DE ETAPA (obligatorias - definen qué puede/no puede hacer)
    sections.push(this.buildStageRules(currentStage, blockedTopics));

    // BLOQUE 3: CONTEXTO OPERATIVO (datos del cliente + pedido activo)
    sections.push(this.buildOperativeContext());

    // BLOQUE 4: CONOCIMIENTO DEL NEGOCIO (RAG filtrado por blockedTopics)
    const ragSection = await this.buildRAGContext(blockedTopics);
    if (ragSection.content) {
      sections.push(ragSection.content);
      ragSectionsUsed = ragSection.count;
    }

    // BLOQUE 5: RESUMEN DE CAPACIDADES (no detalla catálogo - LLM2 busca cuando necesita)
    sections.push(this.buildCapabilitiesSummary());

    // BLOQUE 5.5: ARCHIVOS DISPONIBLES DEL AGENTE (fotos, documentos que puede enviar)
    const agentFilesSection = this.buildAgentFilesSection();
    if (agentFilesSection) {
      sections.push(agentFilesSection);
    }

    // BLOQUE 6: ACCIONES AUTOMÁTICAS Y ANÁLISIS DE MULTIMEDIA
    // Incluir si hay cualquier trigger, análisis de imagen, o voucher detectado
    const hasTriggerContent = this.triggerContext.autoTriggerResult || 
                               this.triggerContext.mediaAnalysis || 
                               this.triggerContext.geminiVoucherResult;
    if (hasTriggerContent) {
      sections.push(this.buildTriggerContext());
    }

    // BLOQUE 7: HERRAMIENTAS DISPONIBLES (filtradas por etapa)
    sections.push(this.buildToolsSection(allowedTools));

    // BLOQUE 8: INSTRUCCIÓN FINAL (siempre al final)
    sections.push(this.buildFinalInstruction());

    const systemPrompt = sections.filter(Boolean).join('\n\n---\n\n');
    const conversationMessages = this.buildCompactedMemory();

    const tokensEstimate = Math.ceil((systemPrompt.length + 
      conversationMessages.reduce((acc, m) => acc + m.content.length, 0)) / 4);

    return {
      systemPrompt,
      conversationMessages,
      allowedTools,
      metadata: {
        tokensEstimate,
        ragSectionsUsed,
        coreSectionsUsed: 1,
        productsIncluded: 0,
        zonesIncluded: 0,
        currentStage: currentStage?.name || null,
        blockedTopics,
        allowedToolNames: allowedTools
      }
    };
  }

  private isTopicBlocked(topic: string, blockedTopics: string[]): boolean {
    const normalizedTopic = topic.toLowerCase();
    return blockedTopics.some(bt => bt.toLowerCase().includes(normalizedTopic) || 
                                     normalizedTopic.includes(bt.toLowerCase()));
  }

  private messagesMentionLocation(): boolean {
    const locationKeywords = [
      'ubicacion', 'ubicación', 'direccion', 'dirección', 'zona', 'envio', 'envío',
      'delivery', 'enviar', 'entregar', 'despacho', 'lima', 'provincia', 'distrito',
      'departamento', 'donde', 'dónde', 'lugar', 'domicilio', 'casa', 'oficina',
      'trabajo', 'llegue', 'llegar', 'entregan', 'dejan', 'reparto', 'cobertura'
    ];
    
    const lastMessages = this.conversationContext.messages.slice(-3);
    const combinedText = lastMessages.map(m => m.content.toLowerCase()).join(' ');
    
    return locationKeywords.some(keyword => combinedText.includes(keyword));
  }

  private buildStageRules(currentStage: any, blockedTopics: string[]): string {
    if (!currentStage) {
      return `## ESTADO DEL FLUJO\nNo hay etapa activa. Responde de forma general.`;
    }

    let rules = `## REGLAS OBLIGATORIAS DE ESTA ETAPA\n`;
    rules += `ETAPA ACTUAL: ${currentStage.name}\n`;
    
    if (currentStage.description) {
      rules += `Objetivo: ${currentStage.description}\n`;
    }

    if (currentStage.promptContext) {
      rules += `\n${currentStage.promptContext}\n`;
    }

    if (currentStage.requiredFieldKeys?.length > 0) {
      const missingFields = this.getMissingFields(currentStage.requiredFieldKeys);
      if (missingFields.length > 0) {
        rules += `\n⚠️ DEBES RECOPILAR ANTES DE AVANZAR:\n`;
        for (const field of missingFields) {
          rules += `- ${field}\n`;
        }
      }
    }

    if (blockedTopics.length > 0) {
      rules += `\n🚫 NO MENCIONES ESTOS TEMAS:\n`;
      for (const topic of blockedTopics) {
        rules += `- ${topic}\n`;
      }
      rules += `Si el cliente pregunta por estos temas, indica que lo verán más adelante.`;
    }

    return rules;
  }

  private getMissingFields(requiredKeys: string[]): string[] {
    const extractedData = this.conversationContext.extractedData || {};
    const missing: string[] = [];
    
    for (const key of requiredKeys) {
      const normalizedKey = key.toLowerCase().replace(/[_\s]/g, '');
      const hasValue = Object.entries(extractedData).some(([k, v]) => {
        const normalizedExtracted = k.toLowerCase().replace(/[_\s]/g, '');
        return (normalizedExtracted === normalizedKey || 
                normalizedExtracted.includes(normalizedKey) || 
                normalizedKey.includes(normalizedExtracted)) && 
               v !== null && v !== undefined && v !== '';
      });
      
      if (!hasValue) {
        missing.push(key);
      }
    }
    
    return missing;
  }

  private buildOperativeContext(): string {
    let context = `## CONTEXTO OPERATIVO\n`;
    
    // Datos extraídos del cliente
    const extractedData = this.conversationContext.extractedData || {};
    const regularEntries = Object.entries(extractedData)
      .filter(([key, v]) => v !== null && v !== undefined && v !== '' && key !== '_session_cart');
    
    if (regularEntries.length > 0) {
      context += `**Datos del cliente:**\n`;
      for (const [key, value] of regularEntries) {
        context += `- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}\n`;
      }
    } else {
      context += `**Datos del cliente:** Ninguno recopilado aún.\n`;
    }
    
    // Sesión de carrito y acciones previas (productos seleccionados en turnos anteriores)
    const sessionCart = extractedData['_session_cart'];
    if (sessionCart && typeof sessionCart === 'object') {
      const session = sessionCart as { productData?: any[]; calculatedTotals?: any; orderId?: string; orderStatus?: string; updatedAt?: string };
      const sessionAge = session.updatedAt ? (Date.now() - new Date(session.updatedAt).getTime()) / 1000 / 60 : 0;
      
      // Only show if session is fresh (less than 30 minutes old)
      if (sessionAge < 30) {
        context += `\n### ACCIONES PREVIAS (NO repetir):\n`;
        
        if (session.productData && session.productData.length > 0) {
          context += `✅ **BÚSQUEDA YA REALIZADA** - Productos encontrados:\n`;
          for (const p of session.productData) {
            context += `  - ${p.title}${p.variation ? ` [${p.variation}]` : ''} - ${this.businessContext.currencySymbol}${p.price}\n`;
          }
        }
        
        if (session.calculatedTotals?.total) {
          context += `✅ **CÁLCULO YA REALIZADO** - Total: ${this.businessContext.currencySymbol}${session.calculatedTotals.total}`;
          if (session.calculatedTotals.zone) {
            context += ` (envío a ${session.calculatedTotals.zone})`;
          }
          context += `\n`;
        }
        
        if (session.orderId) {
          context += `✅ **ORDEN YA CREADA** - ID: ${session.orderId.slice(-8)} (Estado: ${session.orderStatus || 'PENDING'})\n`;
          context += `  → Para agregar productos usa: objetivo "agregar [producto] a la orden"\n`;
          context += `  → Para registrar pago usa: objetivo "registrar pago", contexto_adicional con voucherImageUrl\n`;
        } else if (session.calculatedTotals?.total) {
          context += `⏳ **PENDIENTE**: Si cliente confirma ("sí", "ok", "dale") → CREA LA ORDEN con ejecutar_accion\n`;
        }
      }
    }
    
    // Pedido activo
    const order = this.conversationContext.existingOrder;
    if (order) {
      context += `\n**Pedido activo:** #${order.id.slice(-6).toUpperCase()}\n`;
      context += `Estado: ${order.status} | Total: ${this.businessContext.currencySymbol}${order.totalAmount}\n`;
      if (order.paidAmount > 0) {
        context += `Pagado: ${this.businessContext.currencySymbol}${order.paidAmount} | `;
        context += `Pendiente: ${this.businessContext.currencySymbol}${order.totalAmount - order.paidAmount}\n`;
      }
    }
    
    return context;
  }

  private buildToolsSection(allowedTools: string[]): string {
    const actionTools = ['buscar_producto', 'calcular_total_pedido', 'confirmar_pedido', 
                         'agregar_producto_orden', 'consultar_pedido', 'agendar_cita', 'ejecutar_accion'];
    
    const hasToolRestriction = allowedTools.length > 0;
    const stageAllowsActions = !hasToolRestriction || allowedTools.some(tool => actionTools.includes(tool));
    
    if (!stageAllowsActions) {
      return `## HERRAMIENTAS
No tienes herramientas disponibles en esta etapa. Solo conversa con el cliente.
NO intentes buscar productos, calcular precios ni crear órdenes hasta avanzar de etapa.`;
    }
    
    return `## HERRAMIENTA: ejecutar_accion

🚨🚨🚨 REGLA ABSOLUTAMENTE OBLIGATORIA 🚨🚨🚨
Cuando el cliente mencione CUALQUIER producto, precio, pedido o compra:
→ DEBES usar ejecutar_accion ANTES de responder
→ NUNCA respondas sobre productos/precios sin llamar primero a ejecutar_accion
→ Si respondes sin usar la herramienta, estarás INVENTANDO información

Tu ÚNICA herramienta es "ejecutar_accion". LLM2 tiene acceso completo a: catálogo de productos, zonas de envío, historial de conversación, y todas las tools de negocio.

### SUB-HERRAMIENTAS DE LLM2 (lo que puede hacer por ti):
| Sub-Tool | Qué hace | Parámetros clave |
|----------|----------|------------------|
| buscar_producto | Busca en catálogo | busqueda: texto a buscar |
| calcular_total_pedido | Calcula subtotal + envío | productos: [{nombre, cantidad}], zona_envio: nombre, descuento_porcentaje (opcional) |
| confirmar_pedido | Crea orden nueva | items, deliveryZoneId, nombre_cliente, direccion, descuento_porcentaje, descuento_razon |
| agregar_producto_orden | Agrega a orden existente | productId, variation, quantity |
| registrar_voucher_pago | Registra pago con voucher | orderId, voucherImageUrl, amount, paymentMethod |
| agendar_cita | Agenda cita/servicio | fecha, hora, servicio, notas |

### CUÁNDO USAR (y qué decirle a LLM2):
- Cliente menciona producto → objetivo: "buscar [nombre exacto que dijo]"
- Cliente pregunta precio → objetivo: "buscar [producto] y obtener precio"
- Cliente pide FOTO/IMAGEN de producto → objetivo: "buscar [producto] y obtener foto"
- Cliente da zona → objetivo: "calcular total de [productos] para [zona]"
- Cliente confirma ("sí", "ok", "dale") → objetivo: "crear orden", contexto_adicional: "producto: X, zona: Y, cliente confirmó"
- Recibe voucher → objetivo: "registrar pago", contexto_adicional: "voucherImageUrl: URL, amount: X, brand: YAPE"

### FORMATO DE LLAMADA:
ejecutar_accion({
  objetivo: "descripción clara de TODAS las tareas a realizar",
  contexto_adicional: "producto: X | variación: Y | zona: Z | cliente: Nombre | dirección: Dir"
})

### ITERACIÓN Y MÚLTIPLES TAREAS:
- Puedes pedir VARIAS tareas en un solo objetivo: "buscar perfume X, calcular total para Lima, y crear orden si todo OK"
- LLM2 iterará hasta 5 veces internamente para completar tareas complejas
- NO necesitas llamar ejecutar_accion múltiples veces - describe todo en un objetivo

### REGLAS CRÍTICAS:
1. NUNCA inventes precios - SIEMPRE usa ejecutar_accion
2. NUNCA digas "no encontré" sin antes buscar con ejecutar_accion
3. Cuando cliente confirma (producto + zona + "sí/ok") → CREA LA ORDEN de inmediato
4. 🚨 FOTOS DE PRODUCTOS - OBLIGATORIO:
   - Cuando el cliente pida foto/imagen de un producto → USA ejecutar_accion con buscar_producto
   - El resultado incluirá "🖼️ FOTO DEL PRODUCTO: https://..." con la URL real
   - COPIA la URL COMPLETA (https://...) y pégala EN TU RESPUESTA en su propia línea
   - NUNCA digas "te muestro la foto" sin incluir la URL real
   - Ejemplo CORRECTO: "Aquí tienes la foto del perfume:\nhttps://minio.example.com/products/perfume.jpg"
   - Ejemplo INCORRECTO: "Te muestro las fotos de los perfumes" (sin URL = cliente NO recibe nada)
5. Si hay voucher detectado → registra el pago con los datos del voucher
6. NO repitas acciones que ya se hicieron (revisa ACCIONES PREVIAS en contexto)
7. NO repitas la misma pregunta o información dos veces en tu respuesta
8. CONFIRMACIÓN DE PAGO: Un "sí" o "ok" del cliente NO confirma un pago. Solo se confirma pago cuando hay análisis de Gemini con monto real, banco e imagen del comprobante. Sin estos datos, NO registres ningún pago.
9. REGLA DE URLs DE IMAGEN: Cada URL de imagen DEBE estar en su propia línea, sin paréntesis ni corchetes alrededor. El sistema automáticamente la convierte en una imagen enviada por WhatsApp.

### ⚠️ PROMOCIONES Y PACKS - REGLAS CRÍTICAS:
Las promociones/packs NO SON PRODUCTOS del catálogo. Son PAQUETES de productos + descuento.

**ENTENDER LA DIFERENCIA:**
- PRODUCTO: Item individual del catálogo (ej: "Perfume Acqua Di Gio 100ml" = S/119.90)
- PROMOCIÓN/PACK: Combinación de productos con descuento (ej: "Pack Élite" = 2 perfumes + 20% OFF)

**CÓMO PROCESAR UNA PROMOCIÓN:**
Cuando cliente pide una promo ("quiero el pack élite", "la promoción 2x1"):
1. PRIMERO: Pregunta qué productos específicos quiere incluir (puede enviar catálogo)
2. SEGUNDO: Cuando el cliente seleccione los productos, búscalos individualmente en el catálogo
3. TERCERO: Calcula el total con los productos REALES + aplica el descuento correspondiente

**EJEMPLO CORRECTO:**
Cliente: "Quiero el pack élite"
Tú: "El Pack Élite incluye 2 perfumes de 100ml con 20% OFF en el segundo. ¿Qué perfumes te gustaría elegir?"
Cliente: [envía productos del catálogo]
Tú: Usas ejecutar_accion para buscar esos productos específicos
Luego: Creas orden con productos reales + descuento_porcentaje: "20", descuento_razon: "Pack Élite 2x1"

**EJEMPLO INCORRECTO (NO HACER):**
❌ Decir "Pack Élite 100ml" como si fuera un producto - NO EXISTE en catálogo
❌ Inventar un precio de "pack" sin calcular productos reales
❌ Crear orden sin los productos individuales que la componen

**EN confirmar_pedido USAR:**
- descuento_porcentaje: número del % de descuento (ej: "20" para 20% OFF)
- descuento_razon: nombre de la promo (ej: "Pack Élite 2x1", "Promo Black Friday")

**PERMITIDO:**
- Si cliente pide promoción para más perfumes, ofrecer catálogo para elegir su segunda opción`;
  }

  private buildFinalInstruction(): string {
    const stage = this.conversationContext.funnelStatus?.currentStage;
    
    let instruction = `## INSTRUCCIÓN FINAL\n`;
    instruction += `Responde al cliente de forma natural, amigable y concisa (máximo 2 párrafos).\n`;
    
    if (stage?.requiredFieldKeys?.length > 0) {
      const missing = this.getMissingFields(stage.requiredFieldKeys);
      if (missing.length > 0) {
        instruction += `Tu objetivo ahora: obtener ${missing[0]}.\n`;
      }
    }
    
    instruction += `No inventes información. Si no sabes algo, pregunta.`;
    
    return instruction;
  }

  private buildCompactedMemory(): { role: 'user' | 'assistant'; content: string }[] {
    const { messages } = this.conversationContext;
    
    const filtered = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-MEMORY_MAX_MESSAGES);
    
    if (filtered.length <= MEMORY_RECENT_FULL) {
      return filtered.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    }
    
    const older = filtered.slice(0, -MEMORY_RECENT_FULL);
    const recent = filtered.slice(-MEMORY_RECENT_FULL);
    
    const compactedOlder = older.map(m => {
      const isAlreadyTruncated = m.content.endsWith('...');
      if (isAlreadyTruncated) {
        return { role: m.role as 'user' | 'assistant', content: m.content };
      }
      return {
        role: m.role as 'user' | 'assistant',
        content: m.content.length > MEMORY_OLDER_TRUNCATE 
          ? m.content.slice(0, MEMORY_OLDER_TRUNCATE).replace(/\s+/g, ' ').trim() + '...'
          : m.content.replace(/\s+/g, ' ').trim()
      };
    });
    
    const fullRecent = recent.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    }));
    
    return [...compactedOlder, ...fullRecent];
  }

  private async buildCoreIdentity(): Promise<string> {
    const { business, promptConfig } = this.businessContext;
    
    let identity = `# IDENTIDAD DEL AGENTE\n`;
    identity += `Eres el asistente virtual de "${business.name}".\n`;
    
    if (promptConfig?.systemPrompt) {
      const processedPrompt = replacePromptVariables(promptConfig.systemPrompt);
      identity += `\n${processedPrompt}\n`;
    }
    
    identity += `\nFecha actual: ${new Date().toLocaleDateString('es-ES', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    })}`;
    
    identity += `\nMoneda: ${this.businessContext.currencySymbol} (${this.businessContext.currencyCode})`;
    identity += `\nObjetivo del negocio: ${this.businessContext.businessObjective}`;
    
    return identity;
  }

  private async buildRAGContext(blockedTopics: string[]): Promise<{ content: string; count: number }> {
    const { business, instanceId } = this.businessContext;
    const { messages } = this.conversationContext;
    
    try {
      // Use last 3 messages for RAG query context (prioritize user messages)
      const userMessages = messages.filter(m => m.role === 'user');
      const lastUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';
      const lastMessages = messages.slice(-3).map(m => m.content).join(' ');
      const ragQuery = lastUserMessage || lastMessages;
      
      console.log(`[ContextBuilder-RAG] Query for RAG: "${ragQuery.substring(0, 100)}..."`);
      console.log(`[ContextBuilder-RAG] BusinessId: ${business.id}, InstanceId: ${instanceId || 'null'}`);
      
      const result = await retrieveRelevantSections(
        business.id,
        ragQuery,
        2,
        instanceId || undefined
      );
      
      console.log(`[ContextBuilder-RAG] Retrieved: ${result.coreSections.length} core + ${result.ragSections.length} semantic sections`);
      
      // Filtrar secciones que pertenecen a temas bloqueados
      const filterByBlockedTopics = (sections: any[]) => {
        if (blockedTopics.length === 0) return sections;
        
        return sections.filter(section => {
          const sectionType = (section.type || '').toLowerCase();
          const sectionTitle = (section.title || '').toLowerCase();
          
          // Excluir si la categoría o título coincide con algún tema bloqueado
          return !blockedTopics.some(topic => {
            const normalizedTopic = topic.toLowerCase();
            return sectionType.includes(normalizedTopic) || 
                   normalizedTopic.includes(sectionType) ||
                   sectionTitle.includes(normalizedTopic);
          });
        });
      };
      
      const filteredCore = filterByBlockedTopics(result.coreSections);
      const filteredRag = filterByBlockedTopics(result.ragSections);
      
      const totalSections = filteredCore.length + filteredRag.length;
      
      if (totalSections === 0) {
        return { content: '', count: 0 };
      }
      
      const filteredResult = { 
        coreSections: filteredCore, 
        ragSections: filteredRag,
        totalTokensEstimate: result.totalTokensEstimate || 0
      };
      const formatted = formatSectionsForPrompt(filteredResult);
      return { content: `## CONOCIMIENTO DEL NEGOCIO\n${formatted}`, count: totalSections };
    } catch (error) {
      console.error('[ContextBuilder] Error retrieving RAG sections:', error);
      return { content: '', count: 0 };
    }
  }

  private buildProductCatalog(): string {
    const { products, currencySymbol } = this.businessContext;
    
    let catalog = `# CATÁLOGO DE PRODUCTOS\n`;
    
    const activeProducts = products.filter((p: any) => p.isActive !== false);
    
    if (activeProducts.length === 0) {
      return catalog + 'No hay productos disponibles actualmente.';
    }
    
    catalog += `Total de productos: ${activeProducts.length}\n\n`;
    
    for (const product of activeProducts.slice(0, 50)) {
      catalog += `- **${product.title}**`;
      if (product.variation) catalog += ` (${product.variation})`;
      catalog += `: ${currencySymbol}${product.price}`;
      if (product.stock !== undefined && product.stock !== null) {
        catalog += ` | Stock: ${product.stock}`;
      }
      if (product.description) {
        catalog += `\n  ${product.description.slice(0, 100)}`;
      }
      catalog += '\n';
    }
    
    if (activeProducts.length > 50) {
      catalog += `\n(... y ${activeProducts.length - 50} productos más)`;
    }
    
    return catalog;
  }

  private buildDeliveryZones(): string {
    const { deliveryZones, currencySymbol } = this.businessContext;
    
    let zones = `# ZONAS DE ENVÍO\n`;
    
    for (const zone of deliveryZones) {
      zones += `- **${zone.name}**: Envío ${currencySymbol}${zone.cost}`;
      if (zone.freeAbove && zone.freeAbove > 0) {
        zones += ` (GRATIS en compras mayores a ${currencySymbol}${zone.freeAbove})`;
      }
      zones += '\n';
    }
    
    zones += `\n⚠️ IMPORTANTE: Siempre usa la herramienta "calcular_total_pedido" para calcular el total exacto incluyendo envío.`;
    
    return zones;
  }

  private buildCapabilitiesSummary(): string {
    const { products, deliveryZones, hasAppointments, businessObjective, currencySymbol } = this.businessContext;
    
    const activeProducts = products.filter((p: any) => p.isActive !== false);
    
    let summary = `## CAPACIDADES DEL NEGOCIO\n`;
    
    if (businessObjective === 'SALES') {
      summary += `Tipo: Ventas/E-commerce\n`;
      summary += `Catálogo: ${activeProducts.length} productos disponibles\n`;
      if (deliveryZones.length > 0) {
        summary += `Zonas de envío: ${deliveryZones.length} zonas configuradas\n`;
      }
      
      // Include product name list so LLM1 knows what exists (prevents hallucination)
      if (activeProducts.length > 0) {
        summary += `\n### PRODUCTOS DISPONIBLES (solo nombres - usa ejecutar_accion para precios):\n`;
        
        // Group by title to show unique products with their variations
        const productMap = new Map<string, string[]>();
        for (const p of activeProducts.slice(0, 30)) {
          const title = p.title || 'Sin nombre';
          if (!productMap.has(title)) {
            productMap.set(title, []);
          }
          if (p.variation) {
            productMap.get(title)!.push(p.variation);
          }
        }
        
        for (const [title, variations] of productMap) {
          if (variations.length > 0) {
            summary += `• ${title} (${variations.slice(0, 3).join(', ')}${variations.length > 3 ? '...' : ''})\n`;
          } else {
            summary += `• ${title}\n`;
          }
        }
        
        if (activeProducts.length > 30) {
          summary += `... y ${activeProducts.length - 30} productos más\n`;
        }
        
        summary += `\n🚨 REGLA CRÍTICA: Solo puedes mencionar productos de esta lista. Si el cliente pregunta por algo que NO está aquí, usa ejecutar_accion para buscarlo - podría existir con otro nombre.\n`;
      }
    } else if (businessObjective === 'APPOINTMENTS') {
      summary += `Tipo: Servicios/Citas\n`;
      if (hasAppointments) {
        summary += `Sistema de citas: Activo\n`;
      }
    }
    
    summary += `\n⚠️ NO TIENES ACCESO A PRECIOS. Usa "ejecutar_accion" para buscar productos, obtener precios exactos, calcular totales y crear órdenes. NUNCA inventes precios.`;
    
    summary += `\n\n📦 PROMOCIONES/PACKS: Las promos NO son productos, son combinaciones de productos + descuento. Cuando cliente pida una promo: pregunta qué productos quiere → búscalos individualmente → aplica el descuento usando descuento_porcentaje y descuento_razon.`;
    
    return summary;
  }

  private buildAgentFilesSection(): string | null {
    const { agentFiles } = this.businessContext;
    
    if (!agentFiles || agentFiles.length === 0) {
      return null;
    }

    let section = `## ARCHIVOS MULTIMEDIA DISPONIBLES\n`;
    section += `Tienes acceso a los siguientes archivos (fotos, documentos) que puedes enviar al cliente cuando sea relevante.\n`;
    section += `Para enviar una imagen o archivo, simplemente incluye la URL en tu respuesta.\n\n`;

    for (const file of agentFiles) {
      section += `### ${file.name}\n`;
      section += `URL: ${file.fileUrl}\n`;
      section += `Tipo: ${file.fileType}\n`;
      
      if (file.description) {
        section += `Descripción: ${file.description}\n`;
      }
      
      if (file.triggerKeywords) {
        section += `Palabras clave: ${file.triggerKeywords}\n`;
      }
      
      if (file.triggerContext) {
        section += `Cuándo usar: ${file.triggerContext}\n`;
      }
      
      section += `\n`;
    }

    section += `📸 INSTRUCCIÓN: Cuando el cliente pregunte sobre algo relacionado con las palabras clave de un archivo, incluye la URL correspondiente en tu respuesta para que pueda ver la imagen o documento.`;
    
    return section;
  }

  private buildOrderContext(): string {
    const { existingOrder } = this.conversationContext;
    const { currencySymbol } = this.businessContext;
    
    let context = `# PEDIDO ACTIVO DEL CLIENTE\n`;
    context += `ID: ${existingOrder.id.slice(-6).toUpperCase()}\n`;
    context += `Estado: ${existingOrder.status}\n`;
    context += `Total: ${currencySymbol}${existingOrder.totalAmount}\n`;
    
    if (existingOrder.paidAmount > 0) {
      context += `Pagado: ${currencySymbol}${existingOrder.paidAmount}\n`;
      context += `Pendiente: ${currencySymbol}${existingOrder.pendingAmount || (existingOrder.totalAmount - existingOrder.paidAmount)}\n`;
    }
    
    if (existingOrder.items && existingOrder.items.length > 0) {
      context += `\nProductos en el pedido:\n`;
      for (const item of existingOrder.items) {
        context += `- ${item.productTitle} x${item.quantity} = ${currencySymbol}${item.unitPrice * item.quantity}\n`;
      }
    }
    
    return context;
  }

  private buildExtractedDataContext(): string {
    const { extractedData } = this.conversationContext;
    
    let context = `# DATOS EXTRAÍDOS DE LA CONVERSACIÓN\n`;
    
    for (const [key, value] of Object.entries(extractedData)) {
      if (value !== null && value !== undefined && value !== '') {
        context += `- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}\n`;
      }
    }
    
    return context;
  }

  private buildFunnelContext(): string {
    const { funnelStatus } = this.conversationContext;
    
    if (!funnelStatus || !funnelStatus.currentStage) {
      return '';
    }
    
    let context = `# ETAPA DEL FLUJO DE VENTA\n`;
    context += `Etapa actual: ${funnelStatus.currentStage.name}\n`;
    
    if (funnelStatus.missingFields && funnelStatus.missingFields.length > 0) {
      context += `\n⚠️ DATOS PENDIENTES DE RECOPILAR:\n`;
      for (const field of funnelStatus.missingFields) {
        context += `- ${field}\n`;
      }
      context += `\nNO AVANCES a la siguiente etapa hasta tener estos datos.`;
    }
    
    if (funnelStatus.blockedTopics && funnelStatus.blockedTopics.length > 0) {
      context += `\n\n🚫 TEMAS BLOQUEADOS (no mencionar hasta avanzar de etapa):\n`;
      for (const topic of funnelStatus.blockedTopics) {
        context += `- ${topic}\n`;
      }
    }
    
    return context;
  }

  private buildTriggerContext(): string {
    const { autoTriggerResult, mediaAnalysis, geminiVoucherResult } = this.triggerContext;
    
    let context = `# ACCIONES AUTOMÁTICAS EJECUTADAS\n`;
    
    if (autoTriggerResult?.contextForAgent) {
      context += autoTriggerResult.contextForAgent + '\n';
    }
    
    if (mediaAnalysis) {
      context += `\nAnálisis de multimedia: ${mediaAnalysis}\n`;
    }
    
    // Incluir datos estructurados del voucher para que el agente pueda registrar el pago
    if (geminiVoucherResult?.isPaymentProof) {
      context += `\n## DATOS DEL VOUCHER DETECTADO\n`;
      context += `- Método de pago: ${geminiVoucherResult.brand || 'No identificado'}\n`;
      context += `- Monto: ${geminiVoucherResult.amount || 'No identificado'}\n`;
      context += `- Código de operación: ${geminiVoucherResult.operationCode || 'No identificado'}\n`;
      if (geminiVoucherResult.imageUrl) {
        context += `- URL de imagen del voucher: ${geminiVoucherResult.imageUrl}\n`;
      }
      context += `\n⚠️ INSTRUCCIÓN OBLIGATORIA PARA REGISTRAR PAGO:\n`;
      context += `Cuando uses ejecutar_accion para registrar este voucher, incluye en contexto_adicional:\n`;
      context += `"voucherImageUrl: ${geminiVoucherResult.imageUrl || 'URL_NO_DISPONIBLE'} | `;
      context += `paymentMethod: ${geminiVoucherResult.brand || 'DESCONOCIDO'} | `;
      context += `amount: ${geminiVoucherResult.amount || 0} | `;
      context += `operationCode: ${geminiVoucherResult.operationCode || 'N/A'}"\n`;
    }
    
    return context;
  }

  private buildResponseGuidelines(): string {
    return `# DIRECTRICES DE RESPUESTA

1. Responde de forma natural, amigable y profesional
2. Mantén las respuestas concisas (máximo 2-3 párrafos)
3. Si el cliente pregunta precios, usa los del catálogo exactamente
4. SIEMPRE usa "calcular_total_pedido" antes de confirmar totales con envío
5. No inventes datos que no tengas
6. Si no entiendes algo, pregunta para clarificar
7. Evita usar emojis excesivos
8. Cuando confirmes un pedido, usa la herramienta "confirmar_pedido"`;
  }

  private buildConversationMessages(): { role: 'user' | 'assistant'; content: string }[] {
    const { messages } = this.conversationContext;
    
    return messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
      }));
  }
}

export async function loadBusinessContext(
  businessId: string,
  instanceId: string | null
): Promise<BusinessContext> {
  const business = await prisma.business.findUnique({
    where: { id: businessId }
  });

  if (!business) {
    throw new Error(`Business not found: ${businessId}`);
  }

  const instanceCondition = instanceId 
    ? { OR: [{ instanceId }, { instanceId: null }] }
    : { instanceId: null };

  const agentPrompt = await prisma.agentPrompt.findFirst({
    where: { 
      businessId,
      ...instanceCondition
    },
    orderBy: { instanceId: 'desc' }
  });
  
  const promptConfig = agentPrompt ? {
    systemPrompt: agentPrompt.prompt,
    bufferSeconds: agentPrompt.bufferSeconds,
    historyLimit: agentPrompt.historyLimit
  } : null;
  
  console.log('[LoadBusinessContext] AgentPrompt:', {
    businessId,
    instanceId,
    hasPrompt: !!agentPrompt,
    promptLength: agentPrompt?.prompt?.length || 0
  });

  // Load agentFiles if we have a prompt
  const agentFilesPromise = agentPrompt 
    ? prisma.agentFile.findMany({
        where: { 
          promptId: agentPrompt.id,
          enabled: true 
        },
        orderBy: { order: 'asc' }
      })
    : Promise.resolve([]);

  const [products, deliveryZones, extractionFields, funnelStages, agentFiles] = await Promise.all([
    prisma.product.findMany({
      where: { businessId, ...instanceCondition },
      take: 100
    }),
    prisma.deliveryZone.findMany({
      where: { businessId, ...instanceCondition }
    }),
    prisma.extractionField.findMany({
      where: { businessId, ...instanceCondition }
    }),
    prisma.funnelStage.findMany({
      where: { businessId, ...instanceCondition },
      orderBy: { order: 'asc' }
    }),
    agentFilesPromise
  ]);

  console.log('[LoadBusinessContext] AgentFiles loaded:', {
    businessId: businessId.slice(0, 8),
    count: agentFiles.length,
    files: agentFiles.map(f => ({ name: f.name, type: f.fileType }))
  });

  return {
    business,
    instanceId,
    products,
    deliveryZones,
    extractionFields,
    funnelStages,
    promptConfig,
    agentFiles,
    currencySymbol: (business as any).currencySymbol || 'S/.',
    currencyCode: (business as any).currencyCode || 'PEN',
    businessObjective: (business as any).businessObjective || 'SALES',
    hasAppointments: (business as any).businessObjective === 'APPOINTMENTS'
  };
}

export async function loadConversationHistory(
  businessId: string,
  contactPhone: string,
  instanceId: string | null,
  limit: number = 20
): Promise<ChatMessage[]> {
  const phone = contactPhone.replace(/\D/g, '');
  const phoneMask = phone.length > 4 ? `***${phone.slice(-4)}` : '****';
  
  console.log(`[ConversationHistory] Loading: business=${businessId.slice(0, 8)}..., phone=${phoneMask}, instanceId=${instanceId?.slice(0, 8) || 'null'}, limit=${limit}`);
  
  const messageFilter: any = {
    businessId,
    direction: { in: ['inbound', 'outbound'] },
    OR: [
      { sender: { endsWith: phone } },
      { recipient: { endsWith: phone } }
    ]
  };
  
  if (instanceId) {
    messageFilter.instanceId = instanceId;
  }

  const recentMessages = await prisma.messageLog.findMany({
    where: messageFilter,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      direction: true,
      message: true,
      createdAt: true,
      instanceId: true
    }
  });
  
  console.log(`[ConversationHistory] Found ${recentMessages.length} messages (instanceFilter=${instanceId ? 'yes' : 'no'})`);
  
  // If no messages found with instanceId filter, try without it as fallback diagnostic
  if (recentMessages.length === 0 && instanceId) {
    const countWithoutInstance = await prisma.messageLog.count({
      where: {
        businessId,
        direction: { in: ['inbound', 'outbound'] },
        OR: [
          { sender: { endsWith: phone } },
          { recipient: { endsWith: phone } }
        ]
      }
    });
    if (countWithoutInstance > 0) {
      console.log(`[ConversationHistory] WARNING: 0 msgs with instanceId=${instanceId?.slice(0, 8)}, but ${countWithoutInstance} msgs exist WITHOUT instance filter - possible instanceId mismatch!`);
    }
  }

  const messages = recentMessages.reverse().map(msg => ({
    role: (msg.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: msg.message || ''
  }));
  
  const compacted = applyMemoryCompaction(messages);
  console.log(`[ConversationHistory] Returning ${compacted.length} messages after compaction`);

  return compacted;
}

function applyMemoryCompaction(messages: Array<ChatMessage & { timestamp?: Date }>): ChatMessage[] {
  if (messages.length <= 5) {
    return messages.map(m => ({ role: m.role, content: m.content }));
  }
  
  const olderMessages = messages.slice(0, -5);
  const recentMessages = messages.slice(-5);
  
  const compactedOlder = olderMessages.map(msg => ({
    role: msg.role,
    content: msg.content.length > 150 ? msg.content.substring(0, 150) + '...' : msg.content
  }));
  
  return [...compactedOlder, ...recentMessages.map(m => ({ role: m.role, content: m.content }))];
}

export async function loadConversationContext(
  businessId: string,
  contactPhone: string,
  instanceId: string | null
): Promise<Omit<ConversationContext, 'messages'>> {
  const [existingOrder, contact, extractedDataRecords] = await Promise.all([
    prisma.order.findFirst({
      where: {
        businessId,
        contactPhone,
        status: { in: ['PENDING_PAYMENT', 'AWAITING_VOUCHER'] },
        ...(instanceId ? { instanceId } : {})
      },
      orderBy: { createdAt: 'desc' },
      include: { items: true }
    }),
    prisma.contact.findFirst({
      where: {
        businessId,
        phone: contactPhone
      }
    }),
    prisma.contactExtractedData.findMany({
      where: {
        businessId,
        contactPhone
      }
    })
  ]);

  const extractedData: Record<string, any> = {};
  for (const record of extractedDataRecords) {
    extractedData[record.fieldKey] = record.fieldValue;
  }

  return {
    contactPhone,
    contactName: contact?.name || '',
    existingOrder,
    extractedData,
    funnelStatus: null,
    contact,
    assignment: null
  };
}

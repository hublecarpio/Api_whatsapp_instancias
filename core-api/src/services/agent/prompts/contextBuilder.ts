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

    // BLOQUE 5: ZONAS DE ENVÍO (si aplica y no está bloqueado)
    if (this.businessContext.deliveryZones.length > 0 && !this.isTopicBlocked('envio', blockedTopics)) {
      sections.push(this.buildDeliveryZones());
    }

    // BLOQUE 6: ACCIONES AUTOMÁTICAS (si hubo triggers)
    if (this.triggerContext.autoTriggerResult) {
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
        zonesIncluded: this.businessContext.deliveryZones.length,
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
    const dataEntries = Object.entries(extractedData).filter(([_, v]) => v !== null && v !== undefined && v !== '');
    
    if (dataEntries.length > 0) {
      context += `**Datos del cliente:**\n`;
      for (const [key, value] of dataEntries) {
        context += `- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}\n`;
      }
    } else {
      context += `**Datos del cliente:** Ninguno recopilado aún.\n`;
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
    if (allowedTools.length === 0) {
      return `## HERRAMIENTAS\nNo tienes herramientas disponibles en esta etapa. Solo conversa.`;
    }
    
    return `## HERRAMIENTAS DISPONIBLES\nPuedes usar SOLO estas herramientas: ${allowedTools.join(', ')}.\nNo intentes usar otras herramientas aunque las conozcas.`;
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
    
    const compactedOlder = older.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content.length > MEMORY_OLDER_TRUNCATE 
        ? m.content.slice(0, MEMORY_OLDER_TRUNCATE).replace(/\s+/g, ' ').trim() + '...'
        : m.content.replace(/\s+/g, ' ').trim()
    }));
    
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
      const lastMessages = messages.slice(-3).map(m => m.content).join(' ');
      const result = await retrieveRelevantSections(
        business.id,
        lastMessages,
        5,
        instanceId || undefined
      );
      
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
    const { autoTriggerResult, mediaAnalysis } = this.triggerContext;
    
    let context = `# ACCIONES AUTOMÁTICAS EJECUTADAS\n`;
    
    if (autoTriggerResult?.contextForAgent) {
      context += autoTriggerResult.contextForAgent + '\n';
    }
    
    if (mediaAnalysis) {
      context += `\nAnálisis de multimedia: ${mediaAnalysis}\n`;
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

  const [products, deliveryZones, extractionFields, funnelStages] = await Promise.all([
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
    })
  ]);

  return {
    business,
    instanceId,
    products,
    deliveryZones,
    extractionFields,
    funnelStages,
    promptConfig,
    agentFiles: [],
    currencySymbol: (business as any).currencySymbol || 'S/.',
    currencyCode: (business as any).currencyCode || 'PEN',
    businessObjective: (business as any).businessObjective || 'SALES',
    hasAppointments: (business as any).businessObjective === 'APPOINTMENTS'
  };
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

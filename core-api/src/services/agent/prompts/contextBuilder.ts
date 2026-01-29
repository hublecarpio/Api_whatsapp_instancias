import prisma from '../../prisma.js';
import { retrieveRelevantSections, formatSectionsForPrompt } from '../../ragService.js';
import { replacePromptVariables } from '../../promptVariables.js';
import { ChatMessage } from '../core/types.js';

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
  metadata: {
    tokensEstimate: number;
    ragSectionsUsed: number;
    coreSectionsUsed: number;
    productsIncluded: number;
    zonesIncluded: number;
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
    const sections: string[] = [];
    let ragSectionsUsed = 0;
    let coreSectionsUsed = 0;

    sections.push(await this.buildCoreIdentity());
    coreSectionsUsed++;

    const ragSection = await this.buildRAGContext();
    if (ragSection.content) {
      sections.push(ragSection.content);
      ragSectionsUsed = ragSection.count;
    }

    if (this.businessContext.products.length > 0) {
      sections.push(this.buildProductCatalog());
    }

    if (this.businessContext.deliveryZones.length > 0) {
      sections.push(this.buildDeliveryZones());
    }

    if (this.conversationContext.existingOrder) {
      sections.push(this.buildOrderContext());
    }

    if (Object.keys(this.conversationContext.extractedData).length > 0) {
      sections.push(this.buildExtractedDataContext());
    }

    if (this.conversationContext.funnelStatus) {
      sections.push(this.buildFunnelContext());
    }

    if (this.triggerContext.autoTriggerResult) {
      sections.push(this.buildTriggerContext());
    }

    sections.push(this.buildResponseGuidelines());

    const systemPrompt = sections.filter(Boolean).join('\n\n---\n\n');

    const conversationMessages = this.buildConversationMessages();

    const tokensEstimate = Math.ceil((systemPrompt.length + 
      conversationMessages.reduce((acc, m) => acc + m.content.length, 0)) / 4);

    return {
      systemPrompt,
      conversationMessages,
      metadata: {
        tokensEstimate,
        ragSectionsUsed,
        coreSectionsUsed,
        productsIncluded: this.businessContext.products.length,
        zonesIncluded: this.businessContext.deliveryZones.length
      }
    };
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

  private async buildRAGContext(): Promise<{ content: string; count: number }> {
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
      
      const totalSections = result.coreSections.length + result.ragSections.length;
      
      if (totalSections === 0) {
        return { content: '', count: 0 };
      }
      
      const formatted = formatSectionsForPrompt(result);
      return { content: `# CONOCIMIENTO DEL NEGOCIO\n${formatted}`, count: totalSections };
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

  const promptConfig = await (prisma as any).promptConfig?.findFirst?.({
    where: { 
      businessId,
      ...(instanceId ? { OR: [{ instanceId }, { instanceId: null }] } : {})
    },
    orderBy: { instanceId: 'desc' }
  }).catch(() => null);

  const [products, deliveryZones, extractionFields, funnelStages] = await Promise.all([
    prisma.product.findMany({
      where: { 
        businessId,
        ...(instanceId ? { OR: [{ instanceId }, { instanceId: null }] } : {})
      },
      take: 100
    }),
    prisma.deliveryZone.findMany({
      where: { 
        businessId,
        ...(instanceId ? { OR: [{ instanceId }, { instanceId: null }] } : {})
      }
    }),
    prisma.extractionField.findMany({
      where: { 
        businessId,
        ...(instanceId ? { OR: [{ instanceId }, { instanceId: null }] } : {})
      }
    }),
    prisma.funnelStage.findMany({
      where: { 
        businessId,
        ...(instanceId ? { OR: [{ instanceId }, { instanceId: null }] } : {})
      },
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

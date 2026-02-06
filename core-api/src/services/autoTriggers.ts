import prisma from './prisma.js';
import { createAutoOrder, checkOrderReady } from './orderAutoCreator.js';
import { getExtractedDataForContact } from './dataExtractionService.js';
import { GeminiService } from './gemini.js';
import { OrderStatus } from '@prisma/client';
import { getClientForModel } from './openaiService.js';
import { createOrder } from './orderService.js';

export type TriggerType = 
  | 'VOUCHER_RECEIVED'
  | 'PURCHASE_CONFIRMED'
  | 'ORDER_READY'
  | 'NONE';

export interface TriggerResult {
  trigger: TriggerType;
  executed: boolean;
  result?: any;
  contextForAgent: string;
  error?: string;
}

export interface TriggerContext {
  businessId: string;
  instanceId?: string;
  contactPhone: string;
  contactName?: string;
  messageText: string;
  mediaUrl?: string;
  mediaType?: string;
  mediaAnalysis?: string;
  geminiVoucherResult?: {
    isPaymentProof: boolean;
    isValid: boolean;
    brand?: string;
    amount?: number;
    currency?: string;
    operationCode?: string;
    confidence: number;
    imageUrl?: string;
  };
}

function logTrigger(action: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
  console.log(`[AUTO-TRIGGER][${action}] ${timestamp} - ${message}${dataStr}`);
}

export async function detectTrigger(ctx: TriggerContext): Promise<TriggerType> {
  const { businessId, instanceId, contactPhone, messageText, geminiVoucherResult } = ctx;
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  logTrigger('DETECT', `Starting trigger detection`, { 
    phone: normalizedPhone, 
    hasVoucherResult: !!geminiVoucherResult,
    messageLength: messageText.length 
  });
  
  if (geminiVoucherResult?.isPaymentProof && geminiVoucherResult?.isValid) {
    logTrigger('DETECT', `Voucher detected by Gemini`, geminiVoucherResult);
    return 'VOUCHER_RECEIVED';
  }
  
  const purchaseConfirmationPhrases = [
    'sí lo quiero', 'si lo quiero', 'confirmo', 'procede', 'adelante',
    'lo llevo', 'me lo llevo', 'lo tomo', 'lo compro', 'va dale',
    'perfecto lo quiero', 'ok lo quiero', 'envíame', 'enviame',
    'quiero hacer el pedido', 'confirmo el pedido', 'procede con el pedido'
  ];
  
  const lowerMessage = messageText.toLowerCase().trim();
  const hasPurchaseConfirmation = purchaseConfirmationPhrases.some(phrase => 
    lowerMessage.includes(phrase)
  );
  
  if (hasPurchaseConfirmation) {
    const orderCheck = await checkOrderReady(businessId, normalizedPhone, instanceId);
    if (orderCheck.ready) {
      logTrigger('DETECT', `Purchase confirmation detected with sufficient data`);
      return 'PURCHASE_CONFIRMED';
    } else {
      logTrigger('DETECT', `Purchase confirmation detected but missing data`, { 
        missingFields: orderCheck.missingFields 
      });
    }
  }
  
  logTrigger('DETECT', `No trigger detected`);
  return 'NONE';
}

export async function executeTrigger(
  trigger: TriggerType,
  ctx: TriggerContext
): Promise<TriggerResult> {
  const { businessId, instanceId, contactPhone, contactName, geminiVoucherResult, mediaUrl } = ctx;
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  logTrigger('EXECUTE', `Executing trigger: ${trigger}`, { phone: normalizedPhone });
  
  if (trigger === 'NONE') {
    return {
      trigger: 'NONE',
      executed: false,
      contextForAgent: ''
    };
  }
  
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { currencySymbol: true }
  });
  const currencySymbol = business?.currencySymbol || 'S/.';
  
  if (trigger === 'VOUCHER_RECEIVED') {
    return await handleVoucherTrigger(
      businessId, 
      instanceId || null, 
      normalizedPhone, 
      contactName || 'Cliente',
      geminiVoucherResult!,
      mediaUrl!,
      currencySymbol
    );
  }
  
  if (trigger === 'PURCHASE_CONFIRMED') {
    return await handlePurchaseConfirmedTrigger(
      businessId,
      instanceId || null,
      normalizedPhone,
      currencySymbol
    );
  }
  
  return {
    trigger,
    executed: false,
    contextForAgent: '',
    error: 'Unknown trigger type'
  };
}

/**
 * Handles voucher received trigger with 3-step flow:
 * 1. Look for active order → attach payment
 * 2. No active order → LLM recovery: analyze conversation to extract/create order
 * 3. Attach payment to recovered order
 * 
 * NO minimal/empty orders are created. If recovery fails, inform the agent.
 */
async function handleVoucherTrigger(
  businessId: string,
  instanceId: string | null,
  contactPhone: string,
  contactName: string,
  voucherResult: NonNullable<TriggerContext['geminiVoucherResult']>,
  mediaUrl: string,
  currencySymbol: string
): Promise<TriggerResult> {
  
  logTrigger('VOUCHER', `Processing voucher trigger`, { 
    contactPhone, 
    amount: voucherResult.amount,
    brand: voucherResult.brand,
    businessId,
    instanceId
  });
  
  try {
    const voucherAmount = voucherResult.amount || 0;
    
    if (voucherAmount <= 0) {
      return {
        trigger: 'VOUCHER_RECEIVED',
        executed: false,
        contextForAgent: `[SISTEMA - VOUCHER CON MONTO INVÁLIDO] Se detectó un comprobante de pago pero no se pudo leer el monto correctamente. Pide al cliente que envíe una foto más clara del comprobante.`,
        error: 'Invalid voucher amount'
      };
    }
    
    // ═══════════════════════════════════════════════════════
    // STEP 1: Look for an active order for this contact
    // ═══════════════════════════════════════════════════════
    let activeOrder = await prisma.order.findFirst({
      where: {
        businessId,
        contactPhone,
        status: { in: [OrderStatus.AWAITING_VOUCHER, OrderStatus.PENDING_PAYMENT] },
        ...(instanceId ? { instanceId } : {})
      },
      orderBy: { createdAt: 'desc' },
      include: { items: true }
    });
    
    logTrigger('VOUCHER', `Active order lookup`, { 
      found: !!activeOrder, 
      orderId: activeOrder?.id?.slice(-6) || 'NONE' 
    });
    
    // ═══════════════════════════════════════════════════════
    // STEP 2: No active order → Try LLM-based recovery
    // Analyze conversation history to extract order details
    // ═══════════════════════════════════════════════════════
    if (!activeOrder) {
      logTrigger('VOUCHER', `No active order found. Starting LLM order recovery...`);
      
      const recoveredOrder = await recoverOrderFromConversation(
        businessId,
        instanceId,
        contactPhone,
        contactName,
        currencySymbol
      );
      
      if (recoveredOrder) {
        activeOrder = recoveredOrder;
        logTrigger('VOUCHER', `Order recovered successfully via LLM`, { 
          orderId: recoveredOrder.id.slice(-6),
          total: recoveredOrder.totalAmount,
          items: recoveredOrder.items?.length || 0
        });
      } else {
        logTrigger('VOUCHER', `LLM recovery failed - no order could be created from conversation`);
        
        return {
          trigger: 'VOUCHER_RECEIVED',
          executed: false,
          contextForAgent: `[SISTEMA - VOUCHER RECIBIDO SIN PEDIDO ACTIVO]
Comprobante detectado: ${currencySymbol}${voucherAmount.toFixed(2)} vía ${voucherResult.brand || 'transferencia'}
Código operación: ${voucherResult.operationCode || 'N/A'}
URL del comprobante: ${mediaUrl}

NO se encontró un pedido activo para este contacto y no se pudo recuperar uno de la conversación.
El pago NO fue registrado aún.

ACCIÓN REQUERIDA: 
1. Informa al cliente que recibiste su comprobante de pago
2. Pregunta qué productos desea ordenar para crear el pedido
3. Una vez tengas productos, dirección y zona de envío, crea el pedido con confirmar_pedido
4. Luego el cliente puede reenviar el comprobante para registrar el pago`,
          error: 'No active order and recovery failed'
        };
      }
    }
    
    // At this point activeOrder is guaranteed non-null (either found or recovered)
    const confirmedOrder = activeOrder!;
    
    // ═══════════════════════════════════════════════════════
    // STEP 3: Attach payment to the order
    // ═══════════════════════════════════════════════════════
    logTrigger('VOUCHER', `Attaching payment to order ${confirmedOrder.id.slice(-6)}`);
    
    const { registerVoucherPayment } = await import('./orderService.js');
    
    const paymentResult = await registerVoucherPayment(
      confirmedOrder.id,
      voucherAmount,
      mediaUrl,
      voucherResult.brand || undefined,
      voucherResult.operationCode || undefined
    );
    
    logTrigger('VOUCHER', `Payment registered`, {
      orderId: confirmedOrder.id.slice(-6),
      voucherAmount,
      newPaidAmount: paymentResult.newPaidAmount,
      totalAmount: paymentResult.totalAmount,
      isFullyPaid: paymentResult.isFullyPaid
    });
    
    const orderShortId = confirmedOrder.id.slice(-6).toUpperCase();
    const productSummary = confirmedOrder.items?.map((i: any) => `${i.productTitle} x${i.quantity}`).join(', ') || 'Productos';
    
    let contextForAgent: string;
    if (paymentResult.isFullyPaid) {
      contextForAgent = `[SISTEMA - PAGO COMPLETO REGISTRADO AUTOMÁTICAMENTE]
Pedido: #${orderShortId}
Productos: ${productSummary}
Pago recibido: ${currencySymbol}${voucherAmount.toFixed(2)} vía ${voucherResult.brand || 'transferencia'}
Total pagado: ${currencySymbol}${paymentResult.newPaidAmount.toFixed(2)} / ${currencySymbol}${paymentResult.totalAmount.toFixed(2)}
Estado: ✅ PAGADO COMPLETAMENTE
Código operación: ${voucherResult.operationCode || 'N/A'}

Confirma al cliente que su pago fue recibido exitosamente y su pedido está confirmado. Informa sobre los próximos pasos (tiempo de envío, etc).`;
    } else {
      contextForAgent = `[SISTEMA - PAGO PARCIAL REGISTRADO AUTOMÁTICAMENTE]
Pedido: #${orderShortId}
Productos: ${productSummary}
Pago recibido: ${currencySymbol}${voucherAmount.toFixed(2)} vía ${voucherResult.brand || 'transferencia'}
Total pagado: ${currencySymbol}${paymentResult.newPaidAmount.toFixed(2)} de ${currencySymbol}${paymentResult.totalAmount.toFixed(2)}
Monto pendiente: ${currencySymbol}${paymentResult.pendingAmount.toFixed(2)}
Código operación: ${voucherResult.operationCode || 'N/A'}

Confirma al cliente que su pago parcial fue recibido. Informa el monto pendiente y solicita que envíe otro comprobante cuando complete el pago.`;
    }
    
    return {
      trigger: 'VOUCHER_RECEIVED',
      executed: true,
      result: {
        orderId: confirmedOrder.id,
        orderShortId,
        voucherAmount,
        paymentResult
      },
      contextForAgent
    };
    
  } catch (error: any) {
    logTrigger('VOUCHER', `Error processing voucher trigger`, { error: error.message });
    return {
      trigger: 'VOUCHER_RECEIVED',
      executed: false,
      contextForAgent: `[SISTEMA - ERROR AL PROCESAR VOUCHER] Hubo un error procesando el comprobante de pago. Por favor, verifica manualmente.`,
      error: error.message
    };
  }
}

/**
 * LLM-based order recovery: Analyzes the last 50 messages of conversation
 * to extract order details (products, quantities, address, zone) and creates
 * the order automatically when a voucher is received but no active order exists.
 * 
 * This handles the edge case where LLM1/LLM2 hallucinated or failed to create
 * the order during the conversation, but the client already agreed on products.
 */
async function recoverOrderFromConversation(
  businessId: string,
  instanceId: string | null,
  contactPhone: string,
  contactName: string,
  currencySymbol: string
): Promise<any | null> {
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  logTrigger('RECOVERY', `Starting LLM order recovery`, { businessId: businessId.slice(0, 8), phone: normalizedPhone });
  
  try {
    // Fetch last 50 messages from the conversation
    const recentMessages = await prisma.messageLog.findMany({
      where: {
        businessId,
        OR: [
          { sender: normalizedPhone },
          { recipient: normalizedPhone },
          { sender: { contains: normalizedPhone } },
          { recipient: { contains: normalizedPhone } }
        ]
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: {
        direction: true,
        sender: true,
        message: true,
        createdAt: true
      }
    });
    
    if (recentMessages.length < 3) {
      logTrigger('RECOVERY', `Not enough conversation history for recovery`, { messageCount: recentMessages.length });
      return null;
    }
    
    // Fetch available products for this business (with instance scoping)
    const products = await prisma.product.findMany({
      where: {
        businessId,
        ...(instanceId ? { OR: [{ instanceId }, { instanceId: null }] } : {})
      },
      select: {
        id: true,
        title: true,
        price: true,
        variations: true,
        pricePerVariation: true,
        stock: true,
        stockPerVariation: true,
        imageUrl: true
      },
      take: 100
    });
    
    // Fetch delivery zones
    const zones = await prisma.deliveryZone.findMany({
      where: { businessId, isActive: true },
      select: { id: true, name: true, cost: true },
      orderBy: { order: 'asc' }
    });
    
    // Build conversation transcript for the LLM
    const transcript = recentMessages.map(m => {
      const role = m.direction === 'inbound' ? 'CLIENTE' : 'AGENTE';
      return `[${role}]: ${m.message || '(sin texto)'}`;
    }).join('\n');
    
    // Build product catalog summary
    const productCatalog = products.map(p => {
      const variations = (p.variations as string[] | null) || [];
      const pricePerVar = (p.pricePerVariation as number[] | null) || [];
      if (variations.length > 0) {
        const varList = variations.map((v, i) => `  - ${v}: ${currencySymbol}${(pricePerVar[i] || p.price).toFixed(2)}`).join('\n');
        return `• ${p.title} (ID: ${p.id})\n${varList}`;
      }
      return `• ${p.title} (ID: ${p.id}) - ${currencySymbol}${p.price.toFixed(2)}`;
    }).join('\n');
    
    const zonesList = zones.map(z => `• ${z.name} (ID: ${z.id}) - Envío: ${currencySymbol}${z.cost.toFixed(2)}`).join('\n');
    
    const systemPrompt = `Eres un analizador de conversaciones de ventas por WhatsApp. Tu tarea es leer la conversación y determinar si el cliente acordó comprar productos específicos.

CATÁLOGO DE PRODUCTOS DISPONIBLES:
${productCatalog || '(Sin productos registrados)'}

ZONAS DE ENVÍO:
${zonesList || '(Sin zonas configuradas)'}

INSTRUCCIONES:
1. Lee toda la conversación cuidadosamente
2. Identifica si el cliente confirmó productos específicos que quiere comprar
3. Busca menciones de dirección de envío, nombre del cliente, zona de entrega
4. Solo extrae información que el cliente CONFIRMÓ explícitamente
5. Los productId DEBEN coincidir con los IDs del catálogo proporcionado arriba
6. Si el cliente mencionó una variación específica (tamaño, color, etc.), inclúyela
7. Si NO encuentras evidencia clara de un pedido confirmado, responde con orderFound: false

IMPORTANTE:
- No inventes datos que no estén en la conversación
- Si hay ambigüedad sobre el producto, no lo incluyas
- Necesitas al menos UN producto confirmado para crear un pedido
- La dirección puede estar parcial - incluye lo que haya`;

    const userPrompt = `CONVERSACIÓN:
${transcript}

Analiza la conversación y responde en JSON estricto con este formato:
{
  "orderFound": true/false,
  "confidence": 0.0-1.0,
  "reason": "explicación breve",
  "items": [
    {
      "productId": "uuid del producto del catálogo",
      "productTitle": "nombre del producto",
      "quantity": 1,
      "unitPrice": 0.00,
      "variation": "variación si aplica o null"
    }
  ],
  "contactName": "nombre del cliente o null",
  "shippingAddress": "dirección de envío o null",
  "deliveryZoneId": "uuid de zona o null",
  "shippingCost": 0.00
}`;

    const { client, normalizedModel } = getClientForModel('gpt-4.1-mini');
    
    logTrigger('RECOVERY', `Calling LLM for order extraction`, { model: normalizedModel, transcriptLength: transcript.length });
    
    const response = await client.chat.completions.create({
      model: normalizedModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.1,
      max_tokens: 1500,
      response_format: { type: 'json_object' }
    });
    
    const content = response.choices[0]?.message?.content;
    if (!content) {
      logTrigger('RECOVERY', `LLM returned empty response`);
      return null;
    }
    
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (parseErr) {
      logTrigger('RECOVERY', `Failed to parse LLM response`, { content: content.substring(0, 200) });
      return null;
    }
    
    logTrigger('RECOVERY', `LLM analysis result`, {
      orderFound: parsed.orderFound,
      confidence: parsed.confidence,
      reason: parsed.reason,
      itemCount: parsed.items?.length || 0
    });
    
    if (!parsed.orderFound || parsed.confidence < 0.5 || !parsed.items || parsed.items.length === 0) {
      logTrigger('RECOVERY', `No order found in conversation (confidence: ${parsed.confidence})`);
      return null;
    }
    
    // Validate product IDs against actual catalog
    const validItems: any[] = [];
    for (const item of parsed.items) {
      if (!item.productId) continue;
      
      const product = products.find(p => p.id === item.productId);
      if (product) {
        let unitPrice = product.price;
        const variations = (product.variations as string[] | null) || [];
        const pricePerVar = (product.pricePerVariation as number[] | null) || [];
        
        if (item.variation && variations.length > 0) {
          const varIndex = variations.findIndex(v => 
            v.toLowerCase().includes(item.variation.toLowerCase()) ||
            item.variation.toLowerCase().includes(v.toLowerCase())
          );
          if (varIndex >= 0 && pricePerVar[varIndex]) {
            unitPrice = pricePerVar[varIndex];
          }
        }
        
        validItems.push({
          productId: product.id,
          productTitle: product.title,
          quantity: Math.max(1, parseInt(item.quantity) || 1),
          unitPrice,
          variation: item.variation || null,
          imageUrl: product.imageUrl
        });
      } else {
        logTrigger('RECOVERY', `Product ID not found in catalog, skipping`, { productId: item.productId, title: item.productTitle });
      }
    }
    
    if (validItems.length === 0) {
      logTrigger('RECOVERY', `No valid products matched from LLM extraction`);
      return null;
    }
    
    // Validate delivery zone
    let deliveryZoneId: string | null = null;
    let shippingCost = 0;
    if (parsed.deliveryZoneId) {
      const zone = zones.find(z => z.id === parsed.deliveryZoneId);
      if (zone) {
        deliveryZoneId = zone.id;
        shippingCost = zone.cost;
      }
    }
    
    // Calculate totals
    const subtotal = validItems.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
    const totalAmount = subtotal + shippingCost;
    
    const resolvedName = parsed.contactName || contactName || 'Cliente';
    const resolvedAddress = parsed.shippingAddress || 'PENDIENTE - Recuperado por sistema';
    
    logTrigger('RECOVERY', `Creating recovered order`, {
      items: validItems.length,
      subtotal,
      shippingCost,
      totalAmount,
      contactName: resolvedName,
      address: resolvedAddress?.substring(0, 50)
    });
    
    const recoveredOrder = await prisma.order.create({
      data: {
        businessId,
        instanceId: instanceId || undefined,
        contactPhone: normalizedPhone,
        contactName: resolvedName,
        shippingAddress: resolvedAddress,
        deliveryZoneId,
        subtotalAmount: subtotal,
        shippingCost,
        totalAmount,
        status: OrderStatus.AWAITING_VOUCHER,
        notes: JSON.stringify({
          recoveredByLLM: true,
          recoveryConfidence: parsed.confidence,
          recoveryReason: parsed.reason,
          recoveredAt: new Date().toISOString()
        }),
        items: {
          create: validItems.map(item => ({
            productId: item.productId,
            productTitle: item.productTitle,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            variation: item.variation,
            imageUrl: item.imageUrl
          }))
        }
      },
      include: { items: true }
    });
    
    logTrigger('RECOVERY', `Order recovered and created`, {
      orderId: recoveredOrder.id.slice(-6),
      total: totalAmount,
      items: recoveredOrder.items.length
    });
    
    return recoveredOrder;
    
  } catch (error: any) {
    logTrigger('RECOVERY', `Error in LLM order recovery`, { error: error.message });
    return null;
  }
}

async function handlePurchaseConfirmedTrigger(
  businessId: string,
  instanceId: string | null,
  contactPhone: string,
  currencySymbol: string
): Promise<TriggerResult> {
  
  logTrigger('PURCHASE', `Processing purchase confirmation trigger`, { contactPhone });
  
  try {
    const existingOrder = await prisma.order.findFirst({
      where: {
        businessId,
        contactPhone,
        status: { in: [OrderStatus.AWAITING_VOUCHER, OrderStatus.PENDING_PAYMENT] },
        ...(instanceId ? { instanceId } : {})
      },
      orderBy: { createdAt: 'desc' }
    });
    
    if (existingOrder) {
      const orderShortId = existingOrder.id.slice(-6).toUpperCase();
      logTrigger('PURCHASE', `Order already exists`, { orderId: existingOrder.id });
      
      return {
        trigger: 'PURCHASE_CONFIRMED',
        executed: false,
        result: { existingOrderId: existingOrder.id },
        contextForAgent: `[SISTEMA - PEDIDO EXISTENTE] El cliente ya tiene un pedido activo (#${orderShortId}). No es necesario crear uno nuevo. Continúa con el proceso de pago.`
      };
    }
    
    const autoOrderResult = await createAutoOrder(businessId, contactPhone, instanceId || undefined, true);
    
    if (autoOrderResult.created && autoOrderResult.orderId) {
      const order = await prisma.order.findUnique({
        where: { id: autoOrderResult.orderId },
        include: { items: true }
      });
      
      const orderShortId = autoOrderResult.orderId.slice(-6).toUpperCase();
      const productSummary = order?.items?.map(i => `${i.productTitle} x${i.quantity} - ${currencySymbol}${i.unitPrice}`).join('\n') || '';
      const total = order?.totalAmount || 0;
      
      logTrigger('PURCHASE', `Order created successfully`, { orderId: autoOrderResult.orderId });
      
      return {
        trigger: 'PURCHASE_CONFIRMED',
        executed: true,
        result: { orderId: autoOrderResult.orderId },
        contextForAgent: `[SISTEMA - PEDIDO CREADO AUTOMÁTICAMENTE]
Pedido: #${orderShortId}
Productos:
${productSummary}
Total: ${currencySymbol}${Number(total).toFixed(2)}
Estado: Esperando pago

Confirma al cliente los detalles del pedido y solicita el comprobante de pago.`
      };
    } else {
      logTrigger('PURCHASE', `Order creation failed`, { reason: autoOrderResult.reason });
      
      return {
        trigger: 'PURCHASE_CONFIRMED',
        executed: false,
        contextForAgent: '',
        error: autoOrderResult.reason
      };
    }
    
  } catch (error: any) {
    logTrigger('PURCHASE', `Error processing purchase trigger`, { error: error.message });
    return {
      trigger: 'PURCHASE_CONFIRMED',
      executed: false,
      contextForAgent: '',
      error: error.message
    };
  }
}

export async function processAutoTriggers(ctx: TriggerContext): Promise<TriggerResult> {
  try {
    const trigger = await detectTrigger(ctx);
    
    if (trigger === 'NONE') {
      return {
        trigger: 'NONE',
        executed: false,
        contextForAgent: ''
      };
    }
    
    return await executeTrigger(trigger, ctx);
    
  } catch (error: any) {
    logTrigger('ERROR', `Error in auto-trigger processing`, { error: error.message });
    return {
      trigger: 'NONE',
      executed: false,
      contextForAgent: '',
      error: error.message
    };
  }
}

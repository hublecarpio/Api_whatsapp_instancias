import prisma from './prisma.js';
import { createAutoOrder, checkOrderReady } from './orderAutoCreator.js';
import { getExtractedDataForContact } from './dataExtractionService.js';
import { GeminiService } from './gemini.js';
import { OrderStatus } from '@prisma/client';

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

/**
 * Detects what automatic trigger should be executed based on the context
 */
export async function detectTrigger(ctx: TriggerContext): Promise<TriggerType> {
  const { businessId, instanceId, contactPhone, messageText, geminiVoucherResult } = ctx;
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  logTrigger('DETECT', `Starting trigger detection`, { 
    phone: normalizedPhone, 
    hasVoucherResult: !!geminiVoucherResult,
    messageLength: messageText.length 
  });
  
  // 1. Check if Gemini detected a valid payment voucher
  if (geminiVoucherResult?.isPaymentProof && geminiVoucherResult?.isValid) {
    logTrigger('DETECT', `Voucher detected by Gemini`, geminiVoucherResult);
    return 'VOUCHER_RECEIVED';
  }
  
  // 2. Check for explicit purchase confirmation in message
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
    // Verify we have enough data to create an order
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
  
  // 3. Check if order is ready based on extracted data (for auto-creation on data update)
  // This is already handled by tryAutoCreateOrderOnDataUpdate, so we skip here
  
  logTrigger('DETECT', `No trigger detected`);
  return 'NONE';
}

/**
 * Executes the appropriate action for the detected trigger
 */
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
  
  // Get business currency
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
 * Handles voucher received trigger - creates order if needed, then processes payment
 * CRITICAL: When a valid voucher is received, ALWAYS create an order to avoid losing sales
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
  
  logTrigger('VOUCHER', `[CRITICAL] Processing voucher trigger - MUST CREATE ORDER`, { 
    contactPhone, 
    amount: voucherResult.amount,
    brand: voucherResult.brand,
    businessId,
    instanceId
  });
  
  try {
    // Step 1: Check if there's already a pending order
    let existingOrder = await prisma.order.findFirst({
      where: {
        businessId,
        contactPhone,
        status: { in: [OrderStatus.AWAITING_VOUCHER, OrderStatus.PENDING_PAYMENT] },
        ...(instanceId ? { instanceId } : {})
      },
      orderBy: { createdAt: 'desc' },
      include: { items: true }
    });
    
    logTrigger('VOUCHER', `Existing order check`, { 
      found: !!existingOrder, 
      orderId: existingOrder?.id 
    });
    
    // Step 2: If no order, try to create one automatically
    if (!existingOrder) {
      logTrigger('VOUCHER', `No existing order found, attempting auto-create`);
      
      const orderCheck = await checkOrderReady(businessId, contactPhone, instanceId || undefined);
      
      if (orderCheck.ready && orderCheck.data) {
        logTrigger('VOUCHER', `Data ready for order creation`, orderCheck.data);
        
        const autoOrderResult = await createAutoOrder(businessId, contactPhone, instanceId || undefined, true);
        
        if (autoOrderResult.created && autoOrderResult.orderId) {
          logTrigger('VOUCHER', `Order auto-created successfully`, { orderId: autoOrderResult.orderId });
          
          existingOrder = await prisma.order.findUnique({
            where: { id: autoOrderResult.orderId },
            include: { items: true }
          });
        } else {
          logTrigger('VOUCHER', `Auto-order creation failed, will create minimal order`, { reason: autoOrderResult.reason });
        }
      } else {
        logTrigger('VOUCHER', `Missing data for full order, will create minimal order`, { 
          missingFields: orderCheck.missingFields 
        });
      }
      
      // CRITICAL FIX: If we still don't have an order, create a MINIMAL order to capture the voucher
      // This prevents losing sales when data extraction didn't capture all fields
      if (!existingOrder && voucherResult.amount && voucherResult.amount > 0) {
        logTrigger('VOUCHER', `[FALLBACK] Creating minimal order to capture voucher payment`);
        
        const voucherAmount = voucherResult.amount;
        
        // Create minimal order with voucher as proof
        const minimalOrder = await prisma.order.create({
          data: {
            businessId,
            instanceId: instanceId || undefined,
            contactPhone,
            contactName: contactName || 'Cliente',
            shippingAddress: 'PENDIENTE - Solicitar al cliente',
            totalAmount: voucherAmount,
            paidAmount: voucherAmount,
            pendingAmount: 0,
            lastVoucherAmount: voucherAmount,
            lastVoucherBank: voucherResult.brand || 'Desconocido',
            voucherImageUrl: mediaUrl,
            voucherReceivedAt: new Date(),
            status: 'PAID',
            paidAt: new Date(),
            notes: JSON.stringify({
              autoCreated: true,
              reason: 'Voucher received before order confirmation',
              voucherDetails: {
                brand: voucherResult.brand,
                amount: voucherAmount,
                currency: voucherResult.currency,
                operationCode: voucherResult.operationCode,
                confidence: voucherResult.confidence
              },
              paymentHistory: [{
                timestamp: new Date().toISOString(),
                amount: voucherAmount,
                brand: voucherResult.brand || 'unknown',
                operationCode: voucherResult.operationCode || null,
                imageUrl: mediaUrl
              }],
              needsDataCompletion: true,
              missingFields: ['productos', 'direccion_completa']
            })
          },
          include: { items: true }
        });
        
        logTrigger('VOUCHER', `[SUCCESS] Minimal order created`, { 
          orderId: minimalOrder.id,
          amount: voucherAmount
        });
        
        const orderShortId = minimalOrder.id.slice(-6).toUpperCase();
        
        return {
          trigger: 'VOUCHER_RECEIVED',
          executed: true,
          result: {
            orderId: minimalOrder.id,
            orderShortId,
            voucherAmount,
            paymentResult: {
              newPaidAmount: voucherAmount,
              totalAmount: voucherAmount,
              pendingAmount: 0,
              isFullyPaid: true
            },
            isMinimalOrder: true
          },
          contextForAgent: `[SISTEMA - PAGO REGISTRADO - COMPLETAR DATOS DEL PEDIDO]
Pedido: #${orderShortId}
Pago recibido: ${currencySymbol}${voucherAmount.toFixed(2)} vía ${voucherResult.brand || 'transferencia'}
Código operación: ${voucherResult.operationCode || 'N/A'}
Estado: ✅ PAGADO

IMPORTANTE: El pago se ha registrado exitosamente, pero NECESITAS completar los datos del pedido:
1. Confirma qué productos exactos desea el cliente
2. Solicita la dirección de envío completa
3. Confirma el nombre del destinatario

Informa al cliente que su pago fue recibido y que necesitas estos datos para procesar el envío.`
        };
      }
    }
    
    if (!existingOrder) {
      logTrigger('VOUCHER', `[ERROR] Could not create any order`, { 
        voucherAmount: voucherResult.amount 
      });
      return {
        trigger: 'VOUCHER_RECEIVED',
        executed: false,
        contextForAgent: `[SISTEMA - ERROR CRÍTICO] No se pudo crear el pedido. El comprobante de pago (${voucherResult.brand || 'Banco/App'}, ${currencySymbol}${voucherResult.amount || '?'}) fue detectado pero hubo un error guardándolo. Informa al cliente que hubo un problema técnico y que reintente o contacte soporte.`,
        error: 'No order found or created'
      };
    }
    
    // Step 3: Process the voucher payment
    logTrigger('VOUCHER', `Processing payment for order ${existingOrder.id}`);
    
    const { registerVoucherPayment } = await import('./orderService.js');
    const voucherAmount = voucherResult.amount || 0;
    
    if (voucherAmount <= 0) {
      return {
        trigger: 'VOUCHER_RECEIVED',
        executed: false,
        contextForAgent: `[SISTEMA - VOUCHER CON MONTO INVÁLIDO] Se detectó un comprobante de pago pero no se pudo leer el monto correctamente. Pide al cliente que envíe una foto más clara del comprobante.`,
        error: 'Invalid voucher amount'
      };
    }
    
    const paymentResult = await registerVoucherPayment(
      existingOrder.id,
      voucherAmount,
      mediaUrl,
      voucherResult.brand || undefined,
      voucherResult.operationCode || undefined
    );
    
    logTrigger('VOUCHER', `Payment registered`, {
      orderId: existingOrder.id,
      voucherAmount,
      newPaidAmount: paymentResult.newPaidAmount,
      totalAmount: paymentResult.totalAmount,
      isFullyPaid: paymentResult.isFullyPaid
    });
    
    // Build context for agent
    const orderShortId = existingOrder.id.slice(-6).toUpperCase();
    const productSummary = existingOrder.items?.map(i => `${i.productTitle} x${i.quantity}`).join(', ') || 'Productos';
    
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
        orderId: existingOrder.id,
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
 * Handles purchase confirmed trigger - creates order automatically
 */
async function handlePurchaseConfirmedTrigger(
  businessId: string,
  instanceId: string | null,
  contactPhone: string,
  currencySymbol: string
): Promise<TriggerResult> {
  
  logTrigger('PURCHASE', `Processing purchase confirmation trigger`, { contactPhone });
  
  try {
    // Check if there's already a pending order
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
    
    // Create order automatically
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

/**
 * Main entry point - detects and executes triggers
 */
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

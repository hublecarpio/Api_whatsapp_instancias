import prisma from './prisma.js';
import { createHash } from 'crypto';
import { getExtractedDataForContact } from './dataExtractionService.js';
import { getContactStageStatus } from './funnelStageService.js';

interface OrderReadyData {
  productId: string;
  productTitle: string;
  quantity: number;
  unitPrice: number;
  contactName: string;
  shippingAddress: string;
  shippingCity?: string;
  shippingCountry?: string;
}

interface AutoOrderResult {
  created: boolean;
  orderId?: string;
  reason: string;
}

const IDEMPOTENCY_WINDOW_MINUTES = 30;
const IDEMPOTENCY_PREFIX = 'AUTO:';

function generateIdempotencyKey(
  businessId: string,
  contactPhone: string,
  productId: string,
  quantity: number,
  address: string
): string {
  const data = `${businessId}:${contactPhone}:${productId}:${quantity}:${address}`.toLowerCase();
  return IDEMPOTENCY_PREFIX + createHash('sha256').update(data).digest('hex').substring(0, 24);
}

export async function checkOrderReady(
  businessId: string,
  contactPhone: string,
  instanceId?: string
): Promise<{ ready: boolean; data?: OrderReadyData; missingFields: string[] }> {
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  const extractedData = await getExtractedDataForContact(businessId, normalizedPhone);
  
  const missingFields: string[] = [];
  
  const productField = extractedData['producto'] || extractedData['product'] || 
                       extractedData['fragancia'] || extractedData['perfume'] ||
                       extractedData['tamaño'] || extractedData['tamano'];
  
  if (!productField) {
    missingFields.push('producto');
  }
  
  const addressField = extractedData['direccion'] || extractedData['address'] || 
                       extractedData['direccion_envio'] || extractedData['ubicacion'];
  
  if (!addressField) {
    missingFields.push('direccion');
  }
  
  const nameField = extractedData['nombre'] || extractedData['name'] || 
                    extractedData['nombre_completo'] || extractedData['cliente'];
  
  if (!nameField) {
    missingFields.push('nombre');
  }

  if (missingFields.length > 0) {
    return { ready: false, missingFields };
  }

  const productWhere: any = {
    businessId,
    OR: [
      { title: { contains: productField, mode: 'insensitive' } },
      { description: { contains: productField, mode: 'insensitive' } }
    ]
  };
  
  if (instanceId) {
    productWhere.OR = [
      { ...productWhere.OR[0], instanceId },
      { ...productWhere.OR[0], instanceId: null },
      { ...productWhere.OR[1], instanceId },
      { ...productWhere.OR[1], instanceId: null }
    ];
  }

  const product = await prisma.product.findFirst({
    where: productWhere,
    orderBy: { createdAt: 'desc' }
  });

  if (!product) {
    return { ready: false, missingFields: ['producto_no_encontrado'] };
  }

  const quantityField = extractedData['cantidad'] || extractedData['quantity'] || '1';
  const quantity = parseInt(quantityField) || 1;

  const cityField = extractedData['ciudad'] || extractedData['city'] || 
                    extractedData['distrito'] || extractedData['district'];

  return {
    ready: true,
    data: {
      productId: product.id,
      productTitle: product.title,
      quantity,
      unitPrice: product.price,
      contactName: nameField,
      shippingAddress: addressField,
      shippingCity: cityField
    },
    missingFields: []
  };
}

const FINAL_STAGE_KEYWORDS = ['confirmar orden', 'confirmar pedido', 'cotización final', 'cotizacion final', 'pago', 'cierre', 'finalizar'];

function isInFinalStage(stageName: string | null | undefined): boolean {
  if (!stageName) return false;
  return FINAL_STAGE_KEYWORDS.some(keyword => stageName.toLowerCase().includes(keyword));
}

export async function createAutoOrder(
  businessId: string,
  contactPhone: string,
  instanceId?: string,
  skipStageCheck: boolean = false
): Promise<AutoOrderResult> {
  try {
    const normalizedPhone = contactPhone.replace(/\D/g, '');
    
    console.log(`[ORDER-AUTO] Checking order readiness for ${normalizedPhone}, instanceId: ${instanceId || 'none'}`);

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { 
        currencyCode: true, 
        currencySymbol: true,
        businessObjective: true 
      }
    });

    if (!business) {
      return { created: false, reason: 'Business not found' };
    }

    if (business.businessObjective !== 'SALES') {
      return { created: false, reason: 'Business objective is not SALES' };
    }

    if (!skipStageCheck) {
      const stageStatus = await getContactStageStatus(businessId, normalizedPhone);
      
      if (!stageStatus.currentStage) {
        return { created: false, reason: 'No funnel stages configured - manual order required' };
      }
      
      if (!isInFinalStage(stageStatus.currentStage.name)) {
        return { created: false, reason: `Not in final stage (current: ${stageStatus.currentStage.name})` };
      }
    }

    const readyCheck = await checkOrderReady(businessId, normalizedPhone, instanceId);
    
    if (!readyCheck.ready || !readyCheck.data) {
      console.log(`[ORDER-AUTO] Not ready for ${normalizedPhone}: missing ${readyCheck.missingFields.join(', ')}`);
      return { created: false, reason: `Missing fields: ${readyCheck.missingFields.join(', ')}` };
    }

    const { data } = readyCheck;
    
    const idempotencyKey = generateIdempotencyKey(
      businessId,
      normalizedPhone,
      data.productId,
      data.quantity,
      data.shippingAddress
    );

    const recentOrder = await prisma.order.findFirst({
      where: {
        businessId,
        contactPhone: normalizedPhone,
        createdAt: {
          gte: new Date(Date.now() - IDEMPOTENCY_WINDOW_MINUTES * 60 * 1000)
        },
        notes: { startsWith: idempotencyKey }
      }
    });

    if (recentOrder) {
      console.log(`[ORDER-AUTO] Duplicate detected for ${normalizedPhone}, existing order: ${recentOrder.id}`);
      return { created: false, orderId: recentOrder.id, reason: 'Duplicate order (idempotency)' };
    }

    const existingPendingOrder = await prisma.order.findFirst({
      where: {
        businessId,
        contactPhone: normalizedPhone,
        instanceId: instanceId || null,
        status: { in: ['PENDING_PAYMENT', 'AWAITING_VOUCHER'] }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (existingPendingOrder) {
      console.log(`[ORDER-AUTO] Updating existing pending order ${existingPendingOrder.id} for ${normalizedPhone}`);
      
      await prisma.order.update({
        where: { id: existingPendingOrder.id },
        data: {
          contactName: data.contactName,
          shippingAddress: data.shippingAddress,
          shippingCity: data.shippingCity,
          notes: `${idempotencyKey} | Auto-updated: ${new Date().toISOString()}`
        }
      });

      return { created: false, orderId: existingPendingOrder.id, reason: 'Updated existing pending order' };
    }

    const totalAmount = data.unitPrice * data.quantity;

    const order = await prisma.order.create({
      data: {
        businessId,
        instanceId: instanceId || null,
        contactPhone: normalizedPhone,
        contactName: data.contactName,
        shippingAddress: data.shippingAddress,
        shippingCity: data.shippingCity || null,
        shippingCountry: data.shippingCountry || null,
        totalAmount,
        currencyCode: business.currencyCode || 'PEN',
        currencySymbol: business.currencySymbol || 'S/.',
        status: 'AWAITING_VOUCHER',
        notes: `${idempotencyKey} | Auto-created: ${new Date().toISOString()}`,
        items: {
          create: [{
            productId: data.productId,
            productTitle: data.productTitle,
            quantity: data.quantity,
            unitPrice: data.unitPrice,
            imageUrl: null
          }]
        }
      }
    });

    console.log(`[ORDER-AUTO] ✓ Order created automatically: ${order.id} for ${normalizedPhone}`);

    return { created: true, orderId: order.id, reason: 'Order created automatically' };

  } catch (error: any) {
    console.error(`[ORDER-AUTO] Error creating order:`, error.message);
    return { created: false, reason: `Error: ${error.message}` };
  }
}

export async function tryAutoCreateOrderOnStageAdvance(
  businessId: string,
  contactPhone: string,
  stageName: string,
  instanceId?: string
): Promise<AutoOrderResult> {
  if (!isInFinalStage(stageName)) {
    return { created: false, reason: `Stage "${stageName}" is not a final stage` };
  }

  console.log(`[ORDER-AUTO] Stage "${stageName}" triggered auto-order check`);
  return createAutoOrder(businessId, contactPhone, instanceId, true);
}

export async function tryAutoCreateOrderOnDataUpdate(
  businessId: string,
  contactPhone: string,
  updatedFieldKey: string,
  instanceId?: string
): Promise<AutoOrderResult> {
  const triggerFields = ['direccion', 'address', 'ubicacion', 'producto', 'fragancia', 'tamano', 'tamaño'];
  
  const shouldTrigger = triggerFields.some(trigger => 
    updatedFieldKey.toLowerCase().includes(trigger)
  );

  if (!shouldTrigger) {
    return { created: false, reason: `Field "${updatedFieldKey}" is not a trigger field` };
  }

  console.log(`[ORDER-AUTO] Field "${updatedFieldKey}" triggered auto-order check`);
  return createAutoOrder(businessId, contactPhone, instanceId, false);
}

import prisma from './prisma.js';
import { getExtractedDataForContact } from './dataExtractionService.js';
import { getContactStageStatus } from './funnelStageService.js';
import { createOrder, findProductWithScope } from './orderService.js';

interface OrderReadyData {
  productId: string | null;
  productTitle: string;
  quantity: number;
  unitPrice: number;
  contactName: string;
  shippingAddress: string;
  shippingCity?: string | null;
  shippingCountry?: string;
}

interface AutoOrderResult {
  created: boolean;
  orderId?: string;
  reason: string;
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

  // Enhanced product search with multiple strategies
  console.log(`[ORDER-AUTO] Searching product: "${productField}" for business ${businessId}, instance: ${instanceId || 'any'}`);
  
  const product = await findProductWithScope(businessId, productField, instanceId);

  if (!product) {
    console.log(`[ORDER-AUTO] Product not found in catalog: "${productField}". Will create manual order.`);
    // Return ready with manual product info - order will be created with productName only
    return {
      ready: true,
      data: {
        productId: null,
        productTitle: productField, // Use extracted product name
        quantity: parseInt(extractedData['cantidad'] || extractedData['quantity'] || '1') || 1,
        unitPrice: 0, // Price unknown, will need manual update
        contactName: nameField,
        shippingAddress: addressField,
        shippingCity: extractedData['ciudad'] || extractedData['city'] || extractedData['distrito'] || null
      },
      missingFields: []
    };
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

    const orderResult = await createOrder({
      businessId,
      instanceId,
      contactPhone: normalizedPhone,
      contactName: data.contactName,
      shippingAddress: data.shippingAddress,
      shippingCity: data.shippingCity,
      shippingCountry: data.shippingCountry,
      items: [{
        productId: data.productId,
        productTitle: data.productTitle,
        quantity: data.quantity,
        unitPrice: data.unitPrice
      }],
      source: 'auto_creator',
      applyPromotions: true
    });

    if (orderResult.success) {
      console.log(`[ORDER-AUTO] ✓ Order ${orderResult.isNew ? 'created' : 'updated'}: ${orderResult.orderId} for ${normalizedPhone}`);
      return { 
        created: orderResult.isNew, 
        orderId: orderResult.orderId, 
        reason: orderResult.isNew ? 'Order created automatically' : 'Updated existing pending order' 
      };
    }

    return { created: false, reason: orderResult.reason };

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

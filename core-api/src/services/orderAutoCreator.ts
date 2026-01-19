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
  
  console.log(`[ORDER-AUTO-DEBUG] ========== checkOrderReady START ==========`);
  console.log(`[ORDER-AUTO-DEBUG] businessId: ${businessId}`);
  console.log(`[ORDER-AUTO-DEBUG] contactPhone: ${normalizedPhone}`);
  console.log(`[ORDER-AUTO-DEBUG] instanceId: ${instanceId || 'none'}`);
  
  const extractedData = await getExtractedDataForContact(businessId, normalizedPhone);
  
  console.log(`[ORDER-AUTO-DEBUG] Extracted data keys: ${Object.keys(extractedData).join(', ') || 'NONE'}`);
  console.log(`[ORDER-AUTO-DEBUG] Extracted data values:`, JSON.stringify(extractedData, null, 2));
  
  const missingFields: string[] = [];
  
  const productField = extractedData['producto'] || extractedData['product'] || 
                       extractedData['fragancia'] || extractedData['perfume'] ||
                       extractedData['tamaño'] || extractedData['tamano'];
  
  console.log(`[ORDER-AUTO-DEBUG] Product field found: "${productField || 'NOT FOUND'}"`);
  console.log(`[ORDER-AUTO-DEBUG] Checked keys for product: producto, product, fragancia, perfume, tamaño, tamano`);
  
  if (!productField) {
    missingFields.push('producto');
  }
  
  const addressField = extractedData['direccion'] || extractedData['address'] || 
                       extractedData['direccion_envio'] || extractedData['ubicacion'];
  
  console.log(`[ORDER-AUTO-DEBUG] Address field found: "${addressField || 'NOT FOUND'}"`);
  console.log(`[ORDER-AUTO-DEBUG] Checked keys for address: direccion, address, direccion_envio, ubicacion`);
  
  if (!addressField) {
    missingFields.push('direccion');
  }
  
  const nameField = extractedData['nombre'] || extractedData['name'] || 
                    extractedData['nombre_completo'] || extractedData['cliente'];
  
  console.log(`[ORDER-AUTO-DEBUG] Name field found: "${nameField || 'NOT FOUND'}"`);
  console.log(`[ORDER-AUTO-DEBUG] Checked keys for name: nombre, name, nombre_completo, cliente`);
  
  if (!nameField) {
    missingFields.push('nombre');
  }

  if (missingFields.length > 0) {
    console.log(`[ORDER-AUTO-DEBUG] ❌ MISSING FIELDS: ${missingFields.join(', ')}`);
    console.log(`[ORDER-AUTO-DEBUG] ========== checkOrderReady END (NOT READY) ==========`);
    return { ready: false, missingFields };
  }

  console.log(`[ORDER-AUTO-DEBUG] ✓ All required fields present, searching for product...`);
  console.log(`[ORDER-AUTO] Searching product: "${productField}" for business ${businessId}, instance: ${instanceId || 'any'}`);
  
  const product = await findProductWithScope(businessId, productField, instanceId);

  if (!product) {
    console.log(`[ORDER-AUTO] Product not found in catalog: "${productField}". Will create manual order.`);
    console.log(`[ORDER-AUTO-DEBUG] ========== checkOrderReady END (READY - MANUAL PRODUCT) ==========`);
    return {
      ready: true,
      data: {
        productId: null,
        productTitle: productField,
        quantity: parseInt(extractedData['cantidad'] || extractedData['quantity'] || '1') || 1,
        unitPrice: 0,
        contactName: nameField,
        shippingAddress: addressField,
        shippingCity: extractedData['ciudad'] || extractedData['city'] || extractedData['distrito'] || null
      },
      missingFields: []
    };
  }

  console.log(`[ORDER-AUTO-DEBUG] ✓ Product found in catalog: ${product.title} (ID: ${product.id})`);

  const quantityField = extractedData['cantidad'] || extractedData['quantity'] || '1';
  const quantity = parseInt(quantityField) || 1;

  const cityField = extractedData['ciudad'] || extractedData['city'] || 
                    extractedData['distrito'] || extractedData['district'];

  console.log(`[ORDER-AUTO-DEBUG] ========== checkOrderReady END (READY) ==========`);
  
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
  const result = FINAL_STAGE_KEYWORDS.some(keyword => stageName.toLowerCase().includes(keyword));
  console.log(`[ORDER-AUTO-DEBUG] isInFinalStage("${stageName}"): ${result}`);
  console.log(`[ORDER-AUTO-DEBUG] Checking against keywords: ${FINAL_STAGE_KEYWORDS.join(', ')}`);
  return result;
}

export async function createAutoOrder(
  businessId: string,
  contactPhone: string,
  instanceId?: string,
  skipStageCheck: boolean = false
): Promise<AutoOrderResult> {
  try {
    const normalizedPhone = contactPhone.replace(/\D/g, '');
    
    console.log(`\n[ORDER-AUTO-DEBUG] ╔══════════════════════════════════════════════════════╗`);
    console.log(`[ORDER-AUTO-DEBUG] ║         createAutoOrder EXECUTION START              ║`);
    console.log(`[ORDER-AUTO-DEBUG] ╚══════════════════════════════════════════════════════╝`);
    console.log(`[ORDER-AUTO-DEBUG] Parameters:`);
    console.log(`[ORDER-AUTO-DEBUG]   - businessId: ${businessId}`);
    console.log(`[ORDER-AUTO-DEBUG]   - contactPhone: ${normalizedPhone}`);
    console.log(`[ORDER-AUTO-DEBUG]   - instanceId: ${instanceId || 'none'}`);
    console.log(`[ORDER-AUTO-DEBUG]   - skipStageCheck: ${skipStageCheck}`);
    console.log(`[ORDER-AUTO] Checking order readiness for ${normalizedPhone}, instanceId: ${instanceId || 'none'}`);

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { 
        id: true,
        name: true,
        currencyCode: true, 
        currencySymbol: true,
        businessObjective: true 
      }
    });

    if (!business) {
      console.log(`[ORDER-AUTO-DEBUG] ❌ FAIL: Business not found with ID: ${businessId}`);
      return { created: false, reason: 'Business not found' };
    }

    console.log(`[ORDER-AUTO-DEBUG] Business found: "${business.name}" (ID: ${business.id})`);
    console.log(`[ORDER-AUTO-DEBUG] Business objective: ${business.businessObjective}`);

    if (business.businessObjective !== 'SALES') {
      console.log(`[ORDER-AUTO-DEBUG] ❌ FAIL: Business objective is "${business.businessObjective}", not "SALES"`);
      console.log(`[ORDER-AUTO-DEBUG] Auto-order only works when businessObjective = SALES`);
      return { created: false, reason: 'Business objective is not SALES' };
    }

    console.log(`[ORDER-AUTO-DEBUG] ✓ Business objective is SALES`);

    if (!skipStageCheck) {
      console.log(`[ORDER-AUTO-DEBUG] Checking funnel stage (skipStageCheck=false)...`);
      const stageStatus = await getContactStageStatus(businessId, normalizedPhone);
      
      console.log(`[ORDER-AUTO-DEBUG] Stage status:`, JSON.stringify({
        currentStage: stageStatus.currentStage?.name || 'none',
        nextStage: stageStatus.nextStage?.name || 'none',
        canAdvance: stageStatus.canAdvance,
        missingFields: stageStatus.missingFields
      }, null, 2));
      
      if (!stageStatus.currentStage) {
        console.log(`[ORDER-AUTO-DEBUG] ❌ FAIL: No funnel stages configured for this business`);
        return { created: false, reason: 'No funnel stages configured - manual order required' };
      }
      
      if (!isInFinalStage(stageStatus.currentStage.name)) {
        console.log(`[ORDER-AUTO-DEBUG] ❌ FAIL: Contact is NOT in a final stage`);
        console.log(`[ORDER-AUTO-DEBUG] Current stage: "${stageStatus.currentStage.name}"`);
        console.log(`[ORDER-AUTO-DEBUG] Required keywords in stage name: ${FINAL_STAGE_KEYWORDS.join(', ')}`);
        return { created: false, reason: `Not in final stage (current: ${stageStatus.currentStage.name})` };
      }
      
      console.log(`[ORDER-AUTO-DEBUG] ✓ Contact is in final stage: "${stageStatus.currentStage.name}"`);
    } else {
      console.log(`[ORDER-AUTO-DEBUG] Skipping stage check (skipStageCheck=true)`);
    }

    const readyCheck = await checkOrderReady(businessId, normalizedPhone, instanceId);
    
    if (!readyCheck.ready || !readyCheck.data) {
      console.log(`[ORDER-AUTO-DEBUG] ❌ FAIL: Order not ready`);
      console.log(`[ORDER-AUTO] Not ready for ${normalizedPhone}: missing ${readyCheck.missingFields.join(', ')}`);
      return { created: false, reason: `Missing fields: ${readyCheck.missingFields.join(', ')}` };
    }

    const { data } = readyCheck;

    console.log(`[ORDER-AUTO-DEBUG] ✓ All checks passed! Creating order...`);
    console.log(`[ORDER-AUTO-DEBUG] Order data:`, JSON.stringify(data, null, 2));

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
      console.log(`[ORDER-AUTO-DEBUG] ✓✓✓ ORDER CREATED SUCCESSFULLY ✓✓✓`);
      console.log(`[ORDER-AUTO] ✓ Order ${orderResult.isNew ? 'created' : 'updated'}: ${orderResult.orderId} for ${normalizedPhone}`);
      return { 
        created: orderResult.isNew, 
        orderId: orderResult.orderId, 
        reason: orderResult.isNew ? 'Order created automatically' : 'Updated existing pending order' 
      };
    }

    console.log(`[ORDER-AUTO-DEBUG] ❌ FAIL: createOrder returned failure`);
    console.log(`[ORDER-AUTO-DEBUG] Reason: ${orderResult.reason}`);
    return { created: false, reason: orderResult.reason };

  } catch (error: any) {
    console.error(`[ORDER-AUTO-DEBUG] ❌ EXCEPTION in createAutoOrder:`, error);
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
  console.log(`\n[ORDER-AUTO-DEBUG] >>> tryAutoCreateOrderOnStageAdvance CALLED <<<`);
  console.log(`[ORDER-AUTO-DEBUG] Stage: "${stageName}", Phone: ${contactPhone}`);
  
  if (!isInFinalStage(stageName)) {
    console.log(`[ORDER-AUTO-DEBUG] Stage "${stageName}" is NOT a final stage - skipping`);
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
  console.log(`\n[ORDER-AUTO-DEBUG] >>> tryAutoCreateOrderOnDataUpdate CALLED <<<`);
  console.log(`[ORDER-AUTO-DEBUG] Updated field: "${updatedFieldKey}", Phone: ${contactPhone}`);
  
  const triggerFields = ['direccion', 'address', 'ubicacion', 'producto', 'fragancia', 'tamano', 'tamaño'];
  
  const shouldTrigger = triggerFields.some(trigger => 
    updatedFieldKey.toLowerCase().includes(trigger)
  );

  console.log(`[ORDER-AUTO-DEBUG] Trigger fields: ${triggerFields.join(', ')}`);
  console.log(`[ORDER-AUTO-DEBUG] Should trigger: ${shouldTrigger}`);

  if (!shouldTrigger) {
    console.log(`[ORDER-AUTO-DEBUG] Field "${updatedFieldKey}" is NOT a trigger field - skipping`);
    return { created: false, reason: `Field "${updatedFieldKey}" is not a trigger field` };
  }

  console.log(`[ORDER-AUTO] Field "${updatedFieldKey}" triggered auto-order check`);
  return createAutoOrder(businessId, contactPhone, instanceId, false);
}

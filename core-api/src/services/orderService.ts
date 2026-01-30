import prisma from './prisma.js';
import { createHash } from 'crypto';
import { findMatchingPromotion, calculateDiscount } from '../routes/promotions.js';
import { getExtractedDataForContact } from './dataExtractionService.js';

const IDEMPOTENCY_WINDOW_MINUTES = 30;
const IDEMPOTENCY_PREFIX = 'ORD:';

// Environment detection for debugging
const IS_REPLIT = process.env.REPL_ID ? true : false;
const ENV_NAME = IS_REPLIT ? 'REPLIT' : 'PRODUCTION';

function logOrder(tag: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const envTag = `[${ENV_NAME}]`;
  const fullTag = `[ORDER-${tag}]`;
  if (data) {
    console.log(`${timestamp} ${envTag} ${fullTag} ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`${timestamp} ${envTag} ${fullTag} ${message}`);
  }
}

export interface OrderItem {
  productId: string | null;
  productTitle: string;
  quantity: number;
  unitPrice: number;
  imageUrl?: string | null;
  variation?: string | null;
}

export interface CreateOrderParams {
  businessId: string;
  instanceId?: string | null;
  contactPhone: string;
  contactName: string;
  shippingAddress: string;
  shippingCity?: string | null;
  shippingCountry?: string | null;
  locationCoordinates?: string | null;
  deliveryZoneId?: string | null;
  shippingCost?: number;
  items: OrderItem[];
  source: 'agent_tool' | 'auto_creator' | 'manual' | 'payment_link';
  skipIdempotency?: boolean;
  applyPromotions?: boolean;
}

export interface CreateOrderResult {
  success: boolean;
  orderId?: string;
  status?: string;
  totalAmount?: number;
  isNew: boolean;
  reason: string;
  awaitingVoucher?: boolean;
}

function generateIdempotencyKey(
  businessId: string,
  contactPhone: string,
  items: OrderItem[]
): string {
  const itemsHash = items.map(i => `${i.productId || i.productTitle}:${i.quantity}`).join('|');
  const data = `${businessId}:${contactPhone}:${itemsHash}`.toLowerCase();
  return IDEMPOTENCY_PREFIX + createHash('sha256').update(data).digest('hex').substring(0, 24);
}

interface ProductWithVariation {
  id: string;
  title: string;
  price: number;
  stock: number;
  imageUrl: string | null;
  variation: string | null;
  variationIndex?: number;
}

function findMatchingVariationIndex(variations: string[], searchTerm: string): number {
  const searchLower = searchTerm.toLowerCase();
  
  for (let i = 0; i < variations.length; i++) {
    const varLower = variations[i].toLowerCase();
    if (varLower === searchLower) return i;
    if (varLower.includes(searchLower) || searchLower.includes(varLower)) return i;
    
    const searchSize = searchLower.match(/(\d+)\s*(ml|lt?|l|kg|g)/i);
    const varSize = varLower.match(/(\d+)\s*(ml|lt?|l|kg|g)/i);
    if (searchSize && varSize && searchSize[1] === varSize[1]) return i;
  }
  
  return -1;
}

export async function findProductWithScope(
  businessId: string,
  searchTerm: string,
  instanceId?: string | null
): Promise<ProductWithVariation | null> {
  const normalizedSearch = searchTerm.trim();
  
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalizedSearch);
  
  if (isUUID) {
    const product = await prisma.product.findFirst({
      where: {
        id: normalizedSearch,
        businessId,
        OR: instanceId ? [
          { instanceId },
          { instanceId: null }
        ] : undefined
      },
      select: { id: true, title: true, price: true, stock: true, imageUrl: true, variations: true, pricePerVariation: true, stockPerVariation: true, imageUrls: true }
    });
    if (!product) return null;
    return {
      id: product.id,
      title: product.title,
      price: product.price,
      stock: product.stockPerVariation.length > 0 ? product.stockPerVariation[0] : product.stock,
      imageUrl: product.imageUrl,
      variation: product.variations.length > 0 ? product.variations[0] : null,
      variationIndex: product.variations.length > 0 ? 0 : undefined
    };
  }
  
  const allProducts = await prisma.product.findMany({
    where: {
      businessId,
      OR: instanceId ? [
        { instanceId },
        { instanceId: null }
      ] : undefined
    },
    select: { id: true, title: true, price: true, stock: true, imageUrl: true, variations: true, pricePerVariation: true, stockPerVariation: true, imageUrls: true }
  });
  
  const searchLower = normalizedSearch.toLowerCase();
  
  for (const product of allProducts) {
    if (product.title.toLowerCase().includes(searchLower)) {
      const varIdx = findMatchingVariationIndex(product.variations, normalizedSearch);
      const stockVal = varIdx >= 0 && product.stockPerVariation[varIdx] !== undefined ? product.stockPerVariation[varIdx] : product.stock;
      return {
        id: product.id,
        title: product.title,
        price: varIdx >= 0 && product.pricePerVariation[varIdx] ? product.pricePerVariation[varIdx] : product.price,
        stock: stockVal,
        imageUrl: varIdx >= 0 && product.imageUrls[varIdx] ? product.imageUrls[varIdx] : product.imageUrl,
        variation: varIdx >= 0 ? product.variations[varIdx] : (product.variations[0] || null),
        variationIndex: varIdx >= 0 ? varIdx : (product.variations.length > 0 ? 0 : undefined)
      };
    }
  }
  
  for (const product of allProducts) {
    if (product.variations && product.variations.length > 0) {
      const varIdx = findMatchingVariationIndex(product.variations, normalizedSearch);
      if (varIdx >= 0) {
        console.log(`[ORDER-SERVICE] Found product by variation "${product.variations[varIdx]}": ${product.title}`);
        return {
          id: product.id,
          title: product.title,
          price: product.pricePerVariation[varIdx] || product.price,
          stock: product.stockPerVariation[varIdx] !== undefined ? product.stockPerVariation[varIdx] : product.stock,
          imageUrl: product.imageUrls[varIdx] || product.imageUrl,
          variation: product.variations[varIdx],
          variationIndex: varIdx
        };
      }
    }
  }
  
  for (const product of allProducts) {
    const combined = `${product.title} ${product.variations.join(' ')}`.toLowerCase();
    if (combined.includes(searchLower)) {
      const varIdx = findMatchingVariationIndex(product.variations, normalizedSearch);
      const stockVal = varIdx >= 0 && product.stockPerVariation[varIdx] !== undefined ? product.stockPerVariation[varIdx] : product.stock;
      return {
        id: product.id,
        title: product.title,
        price: varIdx >= 0 && product.pricePerVariation[varIdx] ? product.pricePerVariation[varIdx] : product.price,
        stock: stockVal,
        imageUrl: varIdx >= 0 && product.imageUrls[varIdx] ? product.imageUrls[varIdx] : product.imageUrl,
        variation: varIdx >= 0 ? product.variations[varIdx] : (product.variations[0] || null),
        variationIndex: varIdx >= 0 ? varIdx : (product.variations.length > 0 ? 0 : undefined)
      };
    }
  }
  
  const wordsToExclude = ['pack', 'und', 'unid', 'x', 'de', 'el', 'la', 'los', 'las', 'un', 'una'];
  const words = normalizedSearch.split(/\s+/).filter((w: string) => 
    w.length > 2 && !wordsToExclude.includes(w.toLowerCase())
  );
  
  for (const word of words) {
    const wordLower = word.toLowerCase();
    for (const product of allProducts) {
      if (product.title.toLowerCase().includes(wordLower)) {
        const varIdx = findMatchingVariationIndex(product.variations, normalizedSearch);
        const stockVal = varIdx >= 0 && product.stockPerVariation[varIdx] !== undefined ? product.stockPerVariation[varIdx] : product.stock;
        console.log(`[ORDER-SERVICE] Found product by word "${word}": ${product.title}`);
        return {
          id: product.id,
          title: product.title,
          price: varIdx >= 0 && product.pricePerVariation[varIdx] ? product.pricePerVariation[varIdx] : product.price,
          stock: stockVal,
          imageUrl: varIdx >= 0 && product.imageUrls[varIdx] ? product.imageUrls[varIdx] : product.imageUrl,
          variation: varIdx >= 0 ? product.variations[varIdx] : (product.variations[0] || null),
          variationIndex: varIdx >= 0 ? varIdx : (product.variations.length > 0 ? 0 : undefined)
        };
      }
    }
  }
  
  return null;
}

export async function checkExistingPendingOrder(
  businessId: string,
  contactPhone: string,
  instanceId?: string | null
): Promise<{ id: string; status: string; totalAmount: number; paidAmount: number; deliveryZoneId: string | null; shippingCost: number | null; discountAmount: number | null } | null> {
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  const existingOrder = await prisma.order.findFirst({
    where: {
      businessId,
      contactPhone: normalizedPhone,
      ...(instanceId ? { instanceId } : {}),
      status: { in: ['PENDING_PAYMENT', 'AWAITING_VOUCHER'] }
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, totalAmount: true, paidAmount: true, deliveryZoneId: true, shippingCost: true, discountAmount: true }
  });
  
  logOrder('CHECK', `Checking for existing pending order`, {
    phone: normalizedPhone,
    found: !!existingOrder,
    orderId: existingOrder?.id,
    status: existingOrder?.status,
    paidAmount: existingOrder?.paidAmount
  });
  
  return existingOrder;
}

export async function createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
  const {
    businessId,
    instanceId,
    contactPhone,
    contactName,
    shippingAddress,
    shippingCity,
    shippingCountry,
    locationCoordinates,
    deliveryZoneId,
    shippingCost = 0,
    items,
    source,
    skipIdempotency = false,
    applyPromotions = true
  } = params;

  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  logOrder('CREATE', `Starting order creation`, {
    phone: normalizedPhone,
    source,
    itemCount: items.length,
    items: items.map(i => ({ title: i.productTitle, qty: i.quantity, price: i.unitPrice })),
    instanceId,
    deliveryZoneId,
    shippingCost,
    hasAddress: !!shippingAddress,
    hasName: !!contactName
  });

  try {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { 
        currencyCode: true, 
        currencySymbol: true,
        businessObjective: true 
      }
    });

    if (!business) {
      return { success: false, isNew: false, reason: 'Business not found' };
    }

    const idempotencyKey = generateIdempotencyKey(businessId, normalizedPhone, items);

    if (!skipIdempotency) {
      const recentOrder = await prisma.order.findFirst({
        where: {
          businessId,
          contactPhone: normalizedPhone,
          idempotencyKey,
          createdAt: {
            gte: new Date(Date.now() - IDEMPOTENCY_WINDOW_MINUTES * 60 * 1000)
          }
        },
        select: { id: true, status: true, totalAmount: true }
      });

      if (recentOrder) {
        logOrder('IDEMPOTENCY', `Order already exists (idempotency hit)`, {
          orderId: recentOrder.id,
          status: recentOrder.status,
          totalAmount: recentOrder.totalAmount
        });
        return { 
          success: true, 
          orderId: recentOrder.id, 
          status: recentOrder.status,
          totalAmount: recentOrder.totalAmount,
          isNew: false, 
          reason: 'Order already exists (idempotency)',
          awaitingVoucher: recentOrder.status === 'AWAITING_VOUCHER'
        };
      }
    }

    const existingPending = await checkExistingPendingOrder(businessId, normalizedPhone, instanceId);
    
    if (existingPending) {
      logOrder('UPDATE', `Updating existing pending order`, {
        orderId: existingPending.id,
        currentStatus: existingPending.status,
        currentTotal: existingPending.totalAmount
      });
      
      const subtotalAmount = items.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
      const totalAmount = subtotalAmount + shippingCost;
      
      await prisma.$transaction(async (tx) => {
        await tx.orderItem.deleteMany({
          where: { orderId: existingPending.id }
        });
        
        await tx.order.update({
          where: { id: existingPending.id },
          data: {
            contactName,
            shippingAddress,
            shippingCity,
            shippingCountry,
            locationCoordinates,
            deliveryZoneId: deliveryZoneId || existingPending.deliveryZoneId || null,
            shippingCost: shippingCost || existingPending.shippingCost || 0,
            subtotalAmount,
            totalAmount,
            idempotencyKey,
            orderSource: source,
            notes: `Updated by ${source}: ${new Date().toISOString()}`,
            items: {
              create: items.map(item => ({
                productId: item.productId,
                productTitle: item.productTitle,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                imageUrl: item.imageUrl
              }))
            }
          }
        });
      });

      return { 
        success: true, 
        orderId: existingPending.id, 
        status: existingPending.status,
        totalAmount,
        isNew: false, 
        reason: 'Updated existing pending order',
        awaitingVoucher: existingPending.status === 'AWAITING_VOUCHER'
      };
    }

    let subtotalAmount = items.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
    
    let promotionId: string | null = null;
    let promotionName: string | null = null;
    let discountType: string | null = null;
    let discountValue: number | null = null;
    let discountAmount: number = 0;
    let giftItems: string | null = null;

    if (applyPromotions && subtotalAmount > 0) {
      const recentMessages = await prisma.messageLog.findMany({
        where: {
          businessId,
          OR: [
            { sender: { contains: normalizedPhone } },
            { recipient: { contains: normalizedPhone } }
          ],
          createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { message: true }
      });

      if (recentMessages.length > 0) {
        const conversationText = recentMessages.map(m => m.message || '').join(' ');
        const matchedPromo = await findMatchingPromotion(businessId, instanceId || null, conversationText);
        
        if (matchedPromo) {
          promotionId = matchedPromo.id;
          promotionName = matchedPromo.name;
          discountType = matchedPromo.discountType;
          discountValue = matchedPromo.discountValue;
          discountAmount = calculateDiscount(subtotalAmount, matchedPromo.discountType, matchedPromo.discountValue);
          giftItems = matchedPromo.giftItems;
          
          console.log(`[ORDER-SERVICE] Applied promotion "${promotionName}": discount ${discountAmount}`);
          
          await prisma.promotion.update({
            where: { id: promotionId },
            data: { usedCount: { increment: 1 } }
          });
        }
      }
    }

    const totalAmount = subtotalAmount - discountAmount + shippingCost;

    try {
      const order = await prisma.$transaction(async (tx) => {
        return tx.order.create({
          data: {
            businessId,
            instanceId: instanceId || null,
            contactPhone: normalizedPhone,
            contactName,
            shippingAddress,
            shippingCity: shippingCity || null,
            shippingCountry: shippingCountry || null,
            locationCoordinates: locationCoordinates || null,
            deliveryZoneId: deliveryZoneId || null,
            shippingCost: shippingCost || 0,
            subtotalAmount,
            totalAmount,
            currencyCode: business.currencyCode || 'PEN',
            currencySymbol: business.currencySymbol || 'S/.',
            status: 'AWAITING_VOUCHER',
            promotionId,
            promotionName,
            discountType,
            discountValue,
            discountAmount,
            giftItems,
            idempotencyKey,
            orderSource: source,
            notes: `Created by ${source}: ${new Date().toISOString()}`,
            items: {
              create: items.map(item => ({
                productId: item.productId,
                productTitle: item.productTitle,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                imageUrl: item.imageUrl
              }))
            }
          },
          include: { items: true }
        });
      });

      logOrder('SUCCESS', `Order created successfully`, {
        orderId: order.id,
        status: 'AWAITING_VOUCHER',
        subtotalAmount,
        shippingCost,
        discountAmount,
        totalAmount,
        itemCount: items.length,
        hasPromotion: !!promotionId,
        promotionName: promotionName || null
      });

      return { 
        success: true, 
        orderId: order.id, 
        status: 'AWAITING_VOUCHER',
        totalAmount,
        isNew: true, 
        reason: 'Order created successfully',
        awaitingVoucher: true
      };
    } catch (createError: any) {
      if (createError.code === 'P2002') {
        console.log(`[ORDER-SERVICE] Unique constraint hit, finding existing order`);
        const existingOrder = await prisma.order.findFirst({
          where: { businessId, contactPhone: normalizedPhone, idempotencyKey },
          select: { id: true, status: true, totalAmount: true }
        });
        if (existingOrder) {
          return { 
            success: true, 
            orderId: existingOrder.id, 
            status: existingOrder.status,
            totalAmount: existingOrder.totalAmount,
            isNew: false, 
            reason: 'Order already exists (idempotency)',
            awaitingVoucher: existingOrder.status === 'AWAITING_VOUCHER'
          };
        }
      }
      throw createError;
    }

  } catch (error: any) {
    logOrder('ERROR', `Failed to create order`, {
      error: error.message,
      stack: error.stack?.split('\n').slice(0, 5).join('\n'),
      phone: normalizedPhone,
      source
    });
    return { success: false, isNew: false, reason: error.message || 'Unknown error' };
  }
}

export interface AgentToolResponse {
  exito: boolean;
  mensaje: string;
  pedido_id?: string;
  total?: number;
  moneda?: string;
  esperando_voucher?: boolean;
  instrucciones?: string;
  error?: string;
}

export function formatAgentToolResponse(result: CreateOrderResult, currencySymbol: string = 'S/.'): AgentToolResponse {
  if (!result.success) {
    return {
      exito: false,
      mensaje: 'No se pudo crear el pedido',
      error: result.reason
    };
  }

  const isNew = result.isNew;
  const mensaje = isNew 
    ? 'Pedido registrado exitosamente' 
    : 'Pedido actualizado exitosamente';

  return {
    exito: true,
    mensaje,
    pedido_id: result.orderId,
    total: result.totalAmount,
    moneda: currencySymbol,
    esperando_voucher: result.awaitingVoucher,
    instrucciones: result.awaitingVoucher 
      ? 'Pide al cliente que envíe el comprobante de pago (voucher/transferencia) para confirmar su pedido.'
      : undefined
  };
}

export interface AddItemResult {
  success: boolean;
  orderId?: string;
  newTotal?: number;
  itemCount?: number;
  reason: string;
}

export async function addItemToExistingOrder(
  businessId: string,
  contactPhone: string,
  item: OrderItem,
  instanceId?: string
): Promise<AddItemResult> {
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  try {
    const existingOrder = await checkExistingPendingOrder(businessId, normalizedPhone, instanceId);
    
    if (!existingOrder) {
      return { success: false, reason: 'No pending order found for this contact' };
    }
    
    const currentItems = await prisma.orderItem.findMany({
      where: { orderId: existingOrder.id }
    });
    
    const existingItem = currentItems.find(i => 
      (i.productId && i.productId === item.productId) || 
      i.productTitle.toLowerCase() === item.productTitle.toLowerCase()
    );
    
    if (existingItem) {
      await prisma.orderItem.update({
        where: { id: existingItem.id },
        data: {
          quantity: existingItem.quantity + item.quantity,
          unitPrice: item.unitPrice || existingItem.unitPrice,
          variation: item.variation || existingItem.variation
        }
      });
      console.log(`[ORDER-SERVICE] Updated existing item quantity in order ${existingOrder.id}`);
    } else {
      await prisma.orderItem.create({
        data: {
          orderId: existingOrder.id,
          productId: item.productId,
          productTitle: item.productTitle,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          imageUrl: item.imageUrl,
          variation: item.variation || null
        }
      });
      console.log(`[ORDER-SERVICE] Added new item to order ${existingOrder.id}`);
    }
    
    const updatedItems = await prisma.orderItem.findMany({
      where: { orderId: existingOrder.id }
    });
    
    const subtotalAmount = updatedItems.reduce((sum, i) => sum + (i.unitPrice * i.quantity), 0);
    const shippingCost = existingOrder.shippingCost || 0;
    const discountAmount = existingOrder.discountAmount || 0;
    const newTotal = subtotalAmount - discountAmount + shippingCost;
    
    await prisma.order.update({
      where: { id: existingOrder.id },
      data: { 
        subtotalAmount,
        totalAmount: newTotal 
      }
    });
    
    return {
      success: true,
      orderId: existingOrder.id,
      newTotal,
      itemCount: updatedItems.length,
      reason: existingItem ? 'Quantity updated for existing item' : 'New item added to order'
    };
  } catch (error: any) {
    console.error('[ORDER-SERVICE] Error adding item to order:', error.message);
    return { success: false, reason: error.message };
  }
}

export interface CreateOrderFromAgentParams {
  businessId: string;
  instanceId?: string | null;
  contactPhone: string;
  producto_id: string;
  cantidad?: number;
  nombre_cliente?: string;
  direccion_envio?: string;
  ciudad?: string;
  pais?: string;
  zona_entrega?: string;
  costo_envio?: number;
}

export interface CreateOrderFromAgentResult {
  exito: boolean;
  mensaje: string;
  pedido_id?: string;
  total?: number;
  moneda?: string;
  orden_activa?: boolean;
  error?: string;
}

export async function createOrderFromAgent(params: CreateOrderFromAgentParams): Promise<CreateOrderFromAgentResult> {
  const {
    businessId,
    instanceId,
    contactPhone,
    producto_id,
    cantidad = 1,
    nombre_cliente,
    direccion_envio,
    ciudad,
    pais,
    zona_entrega,
    costo_envio
  } = params;

  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  console.log(`[ORDER-FROM-AGENT] Creating order for ${normalizedPhone}, product: "${producto_id}", qty: ${cantidad}`);

  try {
    // Get business info for currency
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { 
        currencyCode: true, 
        currencySymbol: true,
        user: { select: { paymentLinkEnabled: true } }
      }
    });

    if (!business) {
      return {
        exito: false,
        mensaje: 'No se pudo crear el pedido',
        error: 'Business not found'
      };
    }

    // Get extracted data from contact
    const extractedData = await getExtractedDataForContact(businessId, normalizedPhone);
    console.log(`[ORDER-FROM-AGENT] Extracted data: ${JSON.stringify(extractedData)}`);

    // Map extracted data to order fields (use agent data if provided, otherwise use extracted)
    const contactName = nombre_cliente || 
      extractedData['nombre'] || 
      extractedData['name'] || 
      extractedData['nombre_completo'] || 
      extractedData['cliente'] || 
      '';

    const shippingAddress = direccion_envio || 
      extractedData['direccion'] || 
      extractedData['address'] || 
      extractedData['direccion_envio'] || 
      extractedData['ubicacion'] || 
      '';

    const shippingCity = ciudad || 
      extractedData['ciudad'] || 
      extractedData['city'] || 
      '';

    const shippingCountry = pais || 
      extractedData['pais'] || 
      extractedData['country'] || 
      '';

    // Find product
    const product = await findProductWithScope(businessId, producto_id, instanceId);
    
    if (!product) {
      return {
        exito: false,
        mensaje: 'No se pudo crear el pedido',
        error: `Producto "${producto_id}" no encontrado en el catálogo`
      };
    }

    // Look up delivery zone and calculate shipping cost
    let shippingCost = costo_envio ?? null;
    let deliveryZoneId: string | null = null;

    // Check if business has delivery zones configured
    const businessHasZones = await prisma.deliveryZone.count({
      where: { businessId, isActive: true }
    }) > 0;

    // If business has delivery zones and neither zona_entrega nor shippingAddress provided, require zone
    if (businessHasZones && !zona_entrega && !shippingAddress) {
      logOrder('CREATE-ERROR', `Business has delivery zones but zona_entrega not provided`, {
        businessId,
        contactPhone: normalizedPhone,
        producto: product.title
      });
      return {
        exito: false,
        mensaje: 'Se requiere especificar la zona de entrega para calcular el costo de envío',
        error: 'Delivery zone required but not provided'
      };
    }

    if (zona_entrega || shippingAddress) {
      // Try to find delivery zone by name, ID, or by address/district
      const zoneSearchTerm = zona_entrega || shippingAddress;
      
      const zone = await prisma.deliveryZone.findFirst({
        where: {
          businessId,
          isActive: true,
          OR: [
            { id: zoneSearchTerm },
            { name: { contains: zoneSearchTerm, mode: 'insensitive' } },
            { districts: { has: zoneSearchTerm } }
          ]
        }
      });

      if (zone) {
        deliveryZoneId = zone.id;
        // Only calculate shipping if agent didn't provide it
        if (shippingCost === null) {
          const subtotal = product.price * cantidad;
          // Check if order qualifies for free shipping
          if (zone.freeAbove && subtotal >= zone.freeAbove) {
            shippingCost = 0;
            logOrder('CREATE', `Free shipping applied (subtotal ${subtotal} >= freeAbove ${zone.freeAbove})`);
          } else {
            shippingCost = zone.cost || 0;
          }
        }
        logOrder('CREATE', `Found delivery zone: ${zone.name}, shippingCost: ${shippingCost}`);
      } else if (businessHasZones) {
        // Business has zones but the provided zone/address was not matched - return error
        logOrder('CREATE-ERROR', `Delivery zone not found: "${zoneSearchTerm}"`, {
          businessId,
          searchTerm: zoneSearchTerm,
          providedZona: zona_entrega,
          providedAddress: shippingAddress
        });
        return {
          exito: false,
          mensaje: zona_entrega 
            ? `Zona de entrega "${zona_entrega}" no encontrada. Por favor verifica el nombre de la zona.`
            : `No se encontró una zona de entrega para la dirección proporcionada. Por favor indica la zona.`,
          error: `Delivery zone not found for: "${zoneSearchTerm}"`
        };
      } else {
        logOrder('CREATE-INFO', `Delivery zone not found but business has no zones configured - proceeding without zone`, {
          businessId,
          searchTerm: zoneSearchTerm
        });
      }
    }

    // Create order
    const orderResult = await createOrder({
      businessId,
      instanceId,
      contactPhone: normalizedPhone,
      contactName,
      shippingAddress,
      shippingCity: shippingCity || null,
      shippingCountry: shippingCountry || null,
      locationCoordinates: null,
      deliveryZoneId,
      shippingCost: shippingCost || 0,
      items: [{
        productId: product.id,
        productTitle: product.title,
        quantity: cantidad,
        unitPrice: product.price,
        imageUrl: product.imageUrl || null
      }],
      source: 'agent_tool'
    });

    if (!orderResult.success) {
      return {
        exito: false,
        mensaje: 'No se pudo crear el pedido',
        error: orderResult.reason
      };
    }

    // Format response
    const currencySymbol = business.currencySymbol || 'S/.';
    let response: CreateOrderFromAgentResult = {
      exito: true,
      mensaje: orderResult.isNew 
        ? 'Pedido registrado exitosamente' 
        : 'Pedido actualizado exitosamente',
      pedido_id: orderResult.orderId,
      total: orderResult.totalAmount,
      moneda: currencySymbol,
      orden_activa: true
    };

    // Add info about active order
    if (orderResult.orderId) {
      response.mensaje += ` La orden está activa en esta conversación. Puedes agregar más productos usando agregar_producto_orden o completar datos faltantes.`;
      
      // Create payment link request record
      await prisma.paymentLinkRequest.create({
        data: {
          businessId,
          contactPhone: normalizedPhone,
          triggerSource: 'agent',
          productId: product.id,
          productName: product.title,
          amount: orderResult.totalAmount || 0,
          quantity: cantidad,
          isSuccess: true,
          orderId: orderResult.orderId,
          isPro: false
        }
      });
    }

    logOrder('AGENT-SUCCESS', `Order ${orderResult.isNew ? 'created' : 'updated'} via agent`, {
      orderId: orderResult.orderId,
      total: orderResult.totalAmount,
      product: product.title,
      quantity: cantidad
    });
    
    return response;
  } catch (error: any) {
    logOrder('AGENT-ERROR', `Failed to create order via agent`, {
      error: error.message,
      product: producto_id,
      phone: contactPhone
    });
    return {
      exito: false,
      mensaje: 'No se pudo crear el pedido',
      error: error.message || 'Unknown error'
    };
  }
}

// ============================================================================
// PAYMENT TRACKING FUNCTIONS
// ============================================================================

export interface VoucherPaymentResult {
  success: boolean;
  orderId: string;
  previousPaidAmount: number;
  newPaidAmount: number;
  totalAmount: number;
  pendingAmount: number;
  isFullyPaid: boolean;
  statusChanged: boolean;
  newStatus?: string;
  message: string;
}

export async function registerVoucherPayment(
  orderId: string,
  voucherAmount: number,
  voucherImageUrl: string,
  voucherBrand?: string,
  operationCode?: string
): Promise<VoucherPaymentResult> {
  logOrder('VOUCHER', `Registering voucher payment`, {
    orderId,
    voucherAmount,
    voucherBrand,
    operationCode,
    hasImage: !!voucherImageUrl
  });

  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        totalAmount: true,
        paidAmount: true,
        status: true,
        currencySymbol: true,
        notes: true
      }
    });

    if (!order) {
      logOrder('VOUCHER-ERROR', `Order not found`, { orderId });
      return {
        success: false,
        orderId,
        previousPaidAmount: 0,
        newPaidAmount: 0,
        totalAmount: 0,
        pendingAmount: 0,
        isFullyPaid: false,
        statusChanged: false,
        message: 'Orden no encontrada'
      };
    }

    const previousPaidAmount = order.paidAmount || 0;
    const newPaidAmount = previousPaidAmount + voucherAmount;
    const pendingAmount = Math.max(0, order.totalAmount - newPaidAmount);
    const isFullyPaid = newPaidAmount >= order.totalAmount;

    // Determine new status based on payment
    let newStatus = order.status;
    let statusChanged = false;

    if (isFullyPaid && order.status !== 'PAID') {
      newStatus = 'PAID';
      statusChanged = true;
    } else if (voucherAmount > 0 && order.status === 'AWAITING_VOUCHER') {
      // Partial payment received but not fully paid - keep as AWAITING_VOUCHER but with paidAmount updated
      newStatus = 'AWAITING_VOUCHER';
    }

    // Build payment history in notes
    let notesData: any = {};
    try {
      notesData = order.notes ? JSON.parse(order.notes) : {};
    } catch (e) {
      notesData = { previousNotes: order.notes };
    }

    if (!notesData.paymentHistory) {
      notesData.paymentHistory = [];
    }

    // Include all voucher evidence per payment for full auditability
    notesData.paymentHistory.push({
      timestamp: new Date().toISOString(),
      amount: voucherAmount,
      brand: voucherBrand || 'unknown',
      operationCode: operationCode || null,
      imageUrl: voucherImageUrl, // Preserve each voucher image URL
      previousTotal: previousPaidAmount,
      newTotal: newPaidAmount
    });

    // Update order with new payment info
    await prisma.order.update({
      where: { id: orderId },
      data: {
        paidAmount: newPaidAmount,
        pendingAmount: pendingAmount,
        lastVoucherAmount: voucherAmount,
        voucherImageUrl,
        voucherReceivedAt: new Date(),
        status: newStatus,
        paidAt: isFullyPaid ? new Date() : undefined,
        notes: JSON.stringify(notesData)
      }
    });

    logOrder('VOUCHER-SUCCESS', `Voucher payment registered`, {
      orderId,
      previousPaidAmount,
      newPaidAmount,
      totalAmount: order.totalAmount,
      pendingAmount,
      isFullyPaid,
      statusChanged,
      newStatus
    });

    const currencySymbol = order.currencySymbol || 'S/.';
    let message = isFullyPaid
      ? `Pago completo recibido. Tu pedido ha sido confirmado.`
      : `Pago parcial de ${currencySymbol}${voucherAmount.toFixed(2)} recibido. Monto pagado: ${currencySymbol}${newPaidAmount.toFixed(2)} de ${currencySymbol}${order.totalAmount.toFixed(2)}. Pendiente: ${currencySymbol}${pendingAmount.toFixed(2)}`;

    return {
      success: true,
      orderId,
      previousPaidAmount,
      newPaidAmount,
      totalAmount: order.totalAmount,
      pendingAmount,
      isFullyPaid,
      statusChanged,
      newStatus,
      message
    };
  } catch (error: any) {
    logOrder('VOUCHER-ERROR', `Failed to register voucher payment`, {
      orderId,
      error: error.message
    });
    return {
      success: false,
      orderId,
      previousPaidAmount: 0,
      newPaidAmount: 0,
      totalAmount: 0,
      pendingAmount: 0,
      isFullyPaid: false,
      statusChanged: false,
      message: error.message || 'Error al registrar el pago'
    };
  }
}

export async function getOrderPaymentStatus(
  businessId: string,
  contactPhone: string,
  instanceId?: string
): Promise<{
  hasActiveOrder: boolean;
  orderId?: string;
  totalAmount?: number;
  paidAmount?: number;
  pendingAmount?: number;
  status?: string;
  items?: { title: string; quantity: number; price: number }[];
} | null> {
  const normalizedPhone = contactPhone.replace(/\D/g, '');

  const order = await prisma.order.findFirst({
    where: {
      businessId,
      contactPhone: normalizedPhone,
      ...(instanceId ? { instanceId } : {}),
      status: { in: ['PENDING_PAYMENT', 'AWAITING_VOUCHER'] }
    },
    orderBy: { createdAt: 'desc' },
    include: { items: true }
  });

  if (!order) {
    return { hasActiveOrder: false };
  }

  return {
    hasActiveOrder: true,
    orderId: order.id,
    totalAmount: order.totalAmount,
    paidAmount: order.paidAmount || 0,
    pendingAmount: order.totalAmount - (order.paidAmount || 0),
    status: order.status,
    items: order.items.map(i => ({
      title: i.productTitle,
      quantity: i.quantity,
      price: i.unitPrice
    }))
  };
}

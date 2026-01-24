import prisma from './prisma.js';
import { createHash } from 'crypto';
import { findMatchingPromotion, calculateDiscount } from '../routes/promotions.js';

const IDEMPOTENCY_WINDOW_MINUTES = 30;
const IDEMPOTENCY_PREFIX = 'ORD:';

export interface OrderItem {
  productId: string | null;
  productTitle: string;
  quantity: number;
  unitPrice: number;
  imageUrl?: string | null;
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

export async function findProductWithScope(
  businessId: string,
  searchTerm: string,
  instanceId?: string | null
): Promise<{ id: string; title: string; price: number; imageUrl: string | null; variation: string | null } | null> {
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
      select: { id: true, title: true, price: true, imageUrl: true, variation: true }
    });
    return product;
  }
  
  let product = await prisma.product.findFirst({
    where: {
      businessId,
      OR: [
        { title: { contains: normalizedSearch, mode: 'insensitive' } },
        { variation: { contains: normalizedSearch, mode: 'insensitive' } }
      ],
      AND: instanceId ? {
        OR: [
          { instanceId },
          { instanceId: null }
        ]
      } : undefined
    },
    select: { id: true, title: true, price: true, imageUrl: true, variation: true }
  });
  
  if (!product) {
    const sizePatternsToKeep = ['100ml', '50ml', '200ml', '250ml', '500ml', '1l', '1lt'];
    const isSizeSearch = sizePatternsToKeep.some(size => 
      normalizedSearch.toLowerCase().includes(size) || normalizedSearch.toLowerCase() === size
    );
    
    if (isSizeSearch) {
      const allProducts = await prisma.product.findMany({
        where: {
          businessId,
          OR: instanceId ? [
            { instanceId },
            { instanceId: null }
          ] : undefined
        },
        select: { id: true, title: true, price: true, imageUrl: true, variation: true }
      });
      
      const searchLower = normalizedSearch.toLowerCase();
      product = allProducts.find(p => {
        const titleLower = p.title.toLowerCase();
        const variationLower = p.variation?.toLowerCase() || '';
        if (titleLower === searchLower || variationLower === searchLower) return true;
        if (titleLower.includes(searchLower) || variationLower.includes(searchLower)) return true;
        
        const searchSize = searchLower.match(/(\d+)\s*(ml|lt?|l)/i);
        const titleSize = titleLower.match(/(\d+)\s*(ml|lt?|l)/i);
        const variationSize = variationLower.match(/(\d+)\s*(ml|lt?|l)/i);
        if (searchSize && (titleSize && searchSize[1] === titleSize[1]) || (variationSize && searchSize?.[1] === variationSize[1])) {
          return true;
        }
        return false;
      }) || null;
      
      if (product) {
        console.log(`[ORDER-SERVICE] Found product by size matching "${normalizedSearch}": ${product.title}`);
      }
    }
  }
  
  if (!product) {
    const wordsToExclude = ['pack', 'und', 'unid', 'x', 'de', 'el', 'la', 'los', 'las', 'un', 'una'];
    const words = normalizedSearch.split(/\s+/).filter((w: string) => 
      w.length > 2 && !wordsToExclude.includes(w.toLowerCase())
    );
    
    for (const word of words) {
      product = await prisma.product.findFirst({
        where: {
          businessId,
          OR: [
            { title: { contains: word, mode: 'insensitive' } },
            { variation: { contains: word, mode: 'insensitive' } }
          ],
          AND: instanceId ? {
            OR: [
              { instanceId },
              { instanceId: null }
            ]
          } : undefined
        },
        select: { id: true, title: true, price: true, imageUrl: true, variation: true }
      });
      
      if (product) {
        console.log(`[ORDER-SERVICE] Found product by word "${word}": ${product.title}`);
        break;
      }
    }
  }
  
  return product;
}

export async function checkExistingPendingOrder(
  businessId: string,
  contactPhone: string,
  instanceId?: string | null
): Promise<{ id: string; status: string; totalAmount: number; deliveryZoneId: string | null; shippingCost: number | null; discountAmount: number | null } | null> {
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  const existingOrder = await prisma.order.findFirst({
    where: {
      businessId,
      contactPhone: normalizedPhone,
      ...(instanceId ? { instanceId } : {}),
      status: { in: ['PENDING_PAYMENT', 'AWAITING_VOUCHER'] }
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, totalAmount: true, deliveryZoneId: true, shippingCost: true, discountAmount: true }
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
  
  console.log(`[ORDER-SERVICE] Creating order for ${normalizedPhone}, source: ${source}, items: ${items.length}`);

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
        console.log(`[ORDER-SERVICE] Idempotency hit: order ${recentOrder.id} already exists`);
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
      console.log(`[ORDER-SERVICE] Updating existing pending order ${existingPending.id}`);
      
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

      console.log(`[ORDER-SERVICE] Order created: ${order.id}, total: ${totalAmount}, status: AWAITING_VOUCHER`);

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
    console.error(`[ORDER-SERVICE] Error creating order:`, error);
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
          unitPrice: item.unitPrice || existingItem.unitPrice
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
          imageUrl: item.imageUrl
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

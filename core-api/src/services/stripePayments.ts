import Stripe from 'stripe';
import prisma from './prisma.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

const PUBLIC_API_URL = process.env.PUBLIC_API_URL || process.env.CORE_API_URL || 'http://localhost:3001';

interface ProductItem {
  productId: string;
  quantity: number;
}

interface CreatePaymentLinkParams {
  businessId: string;
  contactPhone: string;
  contactName?: string;
  items: ProductItem[];
  shippingAddress?: string;
  shippingCity?: string;
  shippingCountry?: string;
  metadata?: Record<string, any>;
}

const CURRENCY_TO_STRIPE: Record<string, string> = {
  'PEN': 'pen',
  'USD': 'usd',
  'EUR': 'eur',
  'MXN': 'mxn',
  'CLP': 'clp',
  'COP': 'cop',
  'ARS': 'ars',
  'BRL': 'brl',
  'GBP': 'gbp'
};

export async function createProductPaymentLink(params: CreatePaymentLinkParams): Promise<{
  success: boolean;
  paymentUrl?: string;
  sessionId?: string;
  orderId?: string;
  error?: string;
}> {
  try {
    const { businessId, contactPhone, contactName, items, shippingAddress, shippingCity, shippingCountry, metadata } = params;

    const business = await prisma.business.findUnique({
      where: { id: businessId }
    });

    if (!business) {
      return { success: false, error: 'Negocio no encontrado' };
    }

    const productIds = items.map(i => i.productId);
    const products = await prisma.product.findMany({
      where: {
        id: { in: productIds },
        businessId
      }
    });

    if (products.length !== items.length) {
      return { success: false, error: 'Uno o más productos no encontrados' };
    }

    for (const item of items) {
      const product = products.find(p => p.id === item.productId);
      if (!product) {
        return { success: false, error: `Producto ${item.productId} no encontrado` };
      }
      if (product.stock < item.quantity) {
        return { success: false, error: `Stock insuficiente para ${product.title}. Disponible: ${product.stock}` };
      }
    }

    let totalAmount = 0;
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
    const orderItems: Array<{
      productId: string;
      productTitle: string;
      quantity: number;
      unitPrice: number;
      imageUrl: string | null;
    }> = [];

    for (const item of items) {
      const product = products.find(p => p.id === item.productId)!;
      const itemTotal = product.price * item.quantity;
      totalAmount += itemTotal;

      const unitAmountCents = Math.round(product.price * 100);

      lineItems.push({
        price_data: {
          currency: CURRENCY_TO_STRIPE[business.currencyCode] || 'usd',
          product_data: {
            name: product.title,
            description: product.description || undefined,
            images: product.imageUrl ? [product.imageUrl] : undefined
          },
          unit_amount: unitAmountCents
        },
        quantity: item.quantity
      });

      orderItems.push({
        productId: product.id,
        productTitle: product.title,
        quantity: item.quantity,
        unitPrice: product.price,
        imageUrl: product.imageUrl
      });
    }

    const order = await prisma.order.create({
      data: {
        businessId,
        contactPhone,
        contactName,
        shippingAddress,
        shippingCity,
        shippingCountry,
        totalAmount,
        currencyCode: business.currencyCode,
        currencySymbol: business.currencySymbol,
        status: 'PENDING_PAYMENT',
        items: {
          create: orderItems
        }
      }
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${PUBLIC_API_URL}/orders/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_API_URL}/orders/cancel?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        orderId: order.id,
        businessId,
        contactPhone,
        ...metadata
      },
      expires_at: Math.floor(Date.now() / 1000) + 1800
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { stripeSessionId: session.id }
    });

    await prisma.paymentSession.create({
      data: {
        businessId,
        contactPhone,
        productIds: items.map(i => i.productId),
        quantities: items.map(i => i.quantity),
        totalAmount,
        currencyCode: business.currencyCode,
        stripeSessionId: session.id,
        paymentUrl: session.url || '',
        status: 'pending',
        metadata: { orderId: order.id, ...metadata },
        expiresAt: new Date(Date.now() + 30 * 60 * 1000)
      }
    });

    return {
      success: true,
      paymentUrl: session.url || undefined,
      sessionId: session.id,
      orderId: order.id
    };
  } catch (error: any) {
    console.error('[STRIPE PAYMENT] Error creating payment link:', error);
    return { success: false, error: error.message };
  }
}

export async function handlePaymentSuccess(sessionId: string): Promise<{
  success: boolean;
  order?: any;
  error?: string;
}> {
  try {
    const order = await prisma.order.findUnique({
      where: { stripeSessionId: sessionId },
      include: { items: true }
    });

    if (!order) {
      return { success: false, error: 'Pedido no encontrado' };
    }

    if (order.status !== 'PENDING_PAYMENT') {
      return { success: true, order };
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return { success: false, error: 'Pago no completado' };
    }

    const updatedOrder = await prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        if (item.productId) {
          await tx.product.update({
            where: { id: item.productId },
            data: {
              stock: { decrement: item.quantity }
            }
          });
        }
      }

      const updated = await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'PAID',
          stripePaymentIntentId: session.payment_intent as string,
          paidAt: new Date()
        },
        include: { items: true }
      });

      await tx.paymentSession.updateMany({
        where: { stripeSessionId: sessionId },
        data: { status: 'completed' }
      });

      return updated;
    });

    console.log(`[STRIPE PAYMENT] Order ${order.id} paid successfully. Stock updated atomically.`);

    return { success: true, order: updatedOrder };
  } catch (error: any) {
    console.error('[STRIPE PAYMENT] Error processing payment success:', error);
    return { success: false, error: error.message };
  }
}

export async function handlePaymentCanceled(sessionId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    await prisma.order.updateMany({
      where: { stripeSessionId: sessionId, status: 'PENDING_PAYMENT' },
      data: { status: 'CANCELLED' }
    });

    await prisma.paymentSession.updateMany({
      where: { stripeSessionId: sessionId },
      data: { status: 'canceled' }
    });

    return { success: true };
  } catch (error: any) {
    console.error('[STRIPE PAYMENT] Error handling payment cancel:', error);
    return { success: false, error: error.message };
  }
}

export async function getOrdersByBusiness(businessId: string, status?: string, limit = 50): Promise<any[]> {
  const where: any = { businessId };
  if (status) {
    where.status = status;
  }

  return prisma.order.findMany({
    where,
    include: { items: true },
    orderBy: { createdAt: 'desc' },
    take: limit
  });
}

export async function getOrderById(orderId: string): Promise<any | null> {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true }
  });
}

export async function updateOrderStatus(orderId: string, status: string): Promise<any> {
  return prisma.order.update({
    where: { id: orderId },
    data: { status: status as any }
  });
}

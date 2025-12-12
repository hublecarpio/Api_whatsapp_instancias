import express from 'express';
import Stripe from 'stripe';
import { authMiddleware } from '../middleware/auth.js';
import prisma from '../services/prisma.js';
import {
  createProductPaymentLink,
  handlePaymentSuccess,
  handlePaymentCanceled,
  getOrdersByBusiness,
  getOrderById,
  updateOrderStatus
} from '../services/stripePayments.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

const INTERNAL_AGENT_SECRET = process.env.INTERNAL_AGENT_SECRET || 'internal-agent-secret-change-me';

router.post('/internal/attach-voucher', async (req, res) => {
  try {
    const internalSecret = req.headers['x-internal-secret'];
    
    if (internalSecret !== INTERNAL_AGENT_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { businessId, contactPhone, voucherImageUrl } = req.body;

    if (!businessId || !contactPhone || !voucherImageUrl) {
      return res.status(400).json({ error: 'businessId, contactPhone y voucherImageUrl son requeridos' });
    }

    const pendingOrder = await prisma.order.findFirst({
      where: {
        businessId,
        contactPhone,
        status: 'AWAITING_VOUCHER'
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!pendingOrder) {
      return res.json({ 
        success: false, 
        message: 'No hay pedido pendiente de voucher para este contacto' 
      });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: pendingOrder.id },
      data: {
        voucherImageUrl,
        voucherReceivedAt: new Date()
      },
      include: { items: true }
    });

    console.log(`[ORDERS INTERNAL] Voucher attached to order ${updatedOrder.id} from ${contactPhone}`);

    res.json({
      success: true,
      orderId: updatedOrder.id,
      message: 'Voucher asociado al pedido exitosamente'
    });
  } catch (error: any) {
    console.error('[ORDERS INTERNAL] Error attaching voucher:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/internal/pending-voucher', async (req, res) => {
  try {
    const internalSecret = req.headers['x-internal-secret'];
    
    if (internalSecret !== INTERNAL_AGENT_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { businessId, contactPhone } = req.query;

    if (!businessId || !contactPhone) {
      return res.status(400).json({ error: 'businessId y contactPhone son requeridos' });
    }

    const pendingOrder = await prisma.order.findFirst({
      where: {
        businessId: businessId as string,
        contactPhone: contactPhone as string,
        status: 'AWAITING_VOUCHER'
      },
      orderBy: { createdAt: 'desc' },
      include: { items: true }
    });

    res.json({
      hasPendingOrder: !!pendingOrder,
      order: pendingOrder
    });
  } catch (error: any) {
    console.error('[ORDERS INTERNAL] Error checking pending voucher:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/pay/:code', async (req, res) => {
  try {
    const { code } = req.params;

    const paymentSession = await prisma.paymentSession.findUnique({
      where: { shortCode: code }
    });

    if (!paymentSession) {
      return res.status(404).json({ success: false, error: 'Enlace de pago no encontrado' });
    }

    if (paymentSession.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Este enlace de pago ya fue utilizado' });
    }

    if (new Date() > paymentSession.expiresAt) {
      return res.status(400).json({ success: false, error: 'Este enlace de pago ha expirado' });
    }

    res.json({
      success: true,
      paymentUrl: paymentSession.paymentUrl
    });
  } catch (error: any) {
    console.error('[ORDERS] Error resolving payment code:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

router.get('/details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const result = await handlePaymentSuccess(sessionId);

    if (!result.success) {
      const order = await prisma.order.findUnique({
        where: { stripeSessionId: sessionId },
        include: { items: true }
      });

      if (!order) {
        return res.status(404).json({ success: false, error: result.error || 'Pedido no encontrado' });
      }

      return res.json({
        success: true,
        order: {
          orderId: order.id,
          totalAmount: order.totalAmount,
          currencySymbol: order.currencySymbol,
          contactName: order.contactName,
          status: order.status,
          items: order.items.map(item => ({
            productTitle: item.productTitle,
            quantity: item.quantity,
            unitPrice: item.unitPrice
          }))
        }
      });
    }

    const updatedOrder = result.order;

    res.json({
      success: true,
      order: {
        orderId: updatedOrder.id,
        totalAmount: updatedOrder.totalAmount,
        currencySymbol: updatedOrder.currencySymbol,
        contactName: updatedOrder.contactName,
        status: updatedOrder.status,
        items: updatedOrder.items.map((item: any) => ({
          productTitle: item.productTitle,
          quantity: item.quantity,
          unitPrice: item.unitPrice
        }))
      }
    });
  } catch (error: any) {
    console.error('[ORDERS] Error fetching order details:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

router.post('/create-payment-link', authMiddleware, async (req: any, res) => {
  try {
    const { businessId, contactPhone, contactName, items, shippingAddress, shippingCity, shippingCountry } = req.body;

    if (!businessId || !contactPhone || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'businessId, contactPhone y items son requeridos' });
    }

    const business = await prisma.business.findFirst({
      where: {
        id: businessId,
        userId: req.userId
      },
      include: {
        user: { select: { paymentLinkEnabled: true } }
      }
    });

    if (!business) {
      return res.status(403).json({ error: 'No tienes acceso a este negocio' });
    }

    const canUsePaymentLink = business.user?.paymentLinkEnabled ?? false;

    if (!canUsePaymentLink) {
      const products = await prisma.product.findMany({
        where: { id: { in: items.map((i: any) => i.productId) } }
      });

      const productMap = new Map(products.map(p => [p.id, p]));
      let totalAmount = 0;

      const orderItems = items.map((item: any) => {
        const product = productMap.get(item.productId);
        const unitPrice = product?.price || item.unitPrice || 0;
        const quantity = item.quantity || 1;
        totalAmount += unitPrice * quantity;

        return {
          productId: item.productId,
          productTitle: product?.title || item.productTitle || 'Producto',
          quantity,
          unitPrice,
          imageUrl: product?.imageUrl || item.imageUrl
        };
      });

      const order = await prisma.order.create({
        data: {
          businessId,
          contactPhone,
          contactName,
          shippingAddress,
          shippingCity,
          shippingCountry,
          totalAmount,
          currencyCode: business.currencyCode || 'PEN',
          currencySymbol: business.currencySymbol || 'S/.',
          status: 'AWAITING_VOUCHER',
          items: {
            create: orderItems
          }
        },
        include: { items: true }
      });

      return res.json({
        success: true,
        orderId: order.id,
        awaitingVoucher: true,
        message: 'Pedido creado. Esperando comprobante de pago.'
      });
    }

    const result = await createProductPaymentLink({
      businessId,
      contactPhone,
      contactName,
      items,
      shippingAddress,
      shippingCity,
      shippingCountry
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({
      success: true,
      paymentUrl: result.paymentUrl,
      sessionId: result.sessionId,
      orderId: result.orderId,
      awaitingVoucher: false
    });
  } catch (error: any) {
    console.error('[ORDERS] Error creating payment link:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/success', async (req, res) => {
  const sessionId = req.query.session_id as string;

  if (!sessionId) {
    return res.status(400).send('Session ID requerido');
  }

  const result = await handlePaymentSuccess(sessionId);

  if (result.success && result.order) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Pago Exitoso</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #10b981 0%, #059669 100%); }
          .container { text-align: center; background: white; padding: 3rem; border-radius: 1rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); max-width: 400px; }
          .icon { font-size: 4rem; margin-bottom: 1rem; }
          h1 { color: #10b981; margin: 0 0 1rem; }
          p { color: #6b7280; margin: 0.5rem 0; }
          .order-id { background: #f3f4f6; padding: 0.5rem 1rem; border-radius: 0.5rem; font-family: monospace; margin-top: 1rem; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon">✅</div>
          <h1>¡Pago Exitoso!</h1>
          <p>Tu pedido ha sido procesado correctamente.</p>
          <p>Recibirás una confirmación por WhatsApp.</p>
          <div class="order-id">Pedido: ${result.order.id.slice(0, 8).toUpperCase()}</div>
        </div>
      </body>
      </html>
    `);
  } else {
    res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Error de Pago</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); }
          .container { text-align: center; background: white; padding: 3rem; border-radius: 1rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); max-width: 400px; }
          .icon { font-size: 4rem; margin-bottom: 1rem; }
          h1 { color: #ef4444; margin: 0 0 1rem; }
          p { color: #6b7280; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon">❌</div>
          <h1>Error</h1>
          <p>${result.error || 'Hubo un problema procesando tu pago.'}</p>
        </div>
      </body>
      </html>
    `);
  }
});

router.get('/cancel', async (req, res) => {
  const sessionId = req.query.session_id as string;

  if (sessionId) {
    await handlePaymentCanceled(sessionId);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Pago Cancelado</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%); }
        .container { text-align: center; background: white; padding: 3rem; border-radius: 1rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); max-width: 400px; }
        .icon { font-size: 4rem; margin-bottom: 1rem; }
        h1 { color: #6b7280; margin: 0 0 1rem; }
        p { color: #6b7280; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">🚫</div>
        <h1>Pago Cancelado</h1>
        <p>Has cancelado el proceso de pago.</p>
        <p>Puedes solicitar un nuevo enlace de pago cuando lo desees.</p>
      </div>
    </body>
    </html>
  `);
});

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: any) {
    console.error('[ORDERS WEBHOOK] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[ORDERS WEBHOOK] Event received: ${event.type}`);

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;

      if (session.mode === 'payment' && session.metadata?.orderId) {
        const result = await handlePaymentSuccess(session.id);

        if (result.success && result.order) {
          console.log(`[ORDERS WEBHOOK] Order ${result.order.id} payment completed`);
        }
      }
    } else if (event.type === 'checkout.session.expired') {
      const session = event.data.object as Stripe.Checkout.Session;

      if (session.metadata?.orderId) {
        await handlePaymentCanceled(session.id);
        console.log(`[ORDERS WEBHOOK] Session expired, order canceled`);
      }
    }

    res.json({ received: true });
  } catch (error: any) {
    console.error('[ORDERS WEBHOOK] Error processing:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/', authMiddleware, async (req: any, res) => {
  try {
    const { businessId, status, limit } = req.query;

    if (!businessId) {
      return res.status(400).json({ error: 'businessId es requerido' });
    }

    const business = await prisma.business.findFirst({
      where: {
        id: businessId,
        userId: req.userId
      }
    });

    if (!business) {
      return res.status(403).json({ error: 'No tienes acceso a este negocio' });
    }

    const orders = await getOrdersByBusiness(
      businessId,
      status as string | undefined,
      limit ? parseInt(limit as string) : 50
    );

    res.json(orders);
  } catch (error: any) {
    console.error('[ORDERS] Error listing orders:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/sync-payment/:sessionId', authMiddleware, async (req: any, res) => {
  try {
    const { sessionId } = req.params;
    
    const paymentSession = await prisma.paymentSession.findUnique({
      where: { stripeSessionId: sessionId }
    });

    if (!paymentSession) {
      return res.status(404).json({ error: 'Sesión de pago no encontrada' });
    }

    const business = await prisma.business.findFirst({
      where: {
        id: paymentSession.businessId,
        userId: req.userId
      }
    });

    if (!business) {
      return res.status(403).json({ error: 'No tienes acceso a este negocio' });
    }

    const result = await handlePaymentSuccess(sessionId);

    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Estado del pago sincronizado correctamente',
        order: result.order
      });
    } else {
      res.json({ 
        success: false, 
        message: result.error || 'No se pudo sincronizar el pago'
      });
    }
  } catch (error: any) {
    console.error('[ORDERS] Error syncing payment:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/payment-links', authMiddleware, async (req: any, res) => {
  try {
    const { businessId, status } = req.query;

    if (!businessId) {
      return res.status(400).json({ error: 'businessId es requerido' });
    }

    const business = await prisma.business.findFirst({
      where: {
        id: businessId,
        userId: req.userId
      }
    });

    if (!business) {
      return res.status(403).json({ error: 'No tienes acceso a este negocio' });
    }

    const whereClause: any = { businessId };
    if (status) {
      whereClause.status = status;
    }

    const paymentLinks = await prisma.paymentSession.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: 100
    });

    const linksWithProducts = await Promise.all(
      paymentLinks.map(async (link) => {
        const productIds = link.productIds as string[];
        const quantities = link.quantities as number[];
        
        const products = await prisma.product.findMany({
          where: { id: { in: productIds } }
        });

        const items = productIds.map((productId, index) => {
          const product = products.find(p => p.id === productId);
          return {
            productId,
            productTitle: product?.title || 'Producto eliminado',
            quantity: quantities[index] || 1,
            unitPrice: product?.price || 0,
            imageUrl: product?.imageUrl
          };
        });

        return {
          ...link,
          items
        };
      })
    );

    res.json(linksWithProducts);
  } catch (error: any) {
    console.error('[ORDERS] Error listing payment links:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:orderId', authMiddleware, async (req: any, res) => {
  try {
    const { orderId } = req.params;

    const order = await getOrderById(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const business = await prisma.business.findFirst({
      where: {
        id: order.businessId,
        userId: req.userId
      }
    });

    if (!business) {
      return res.status(403).json({ error: 'No tienes acceso a este pedido' });
    }

    res.json(order);
  } catch (error: any) {
    console.error('[ORDERS] Error getting order:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:orderId/voucher', authMiddleware, async (req: any, res) => {
  try {
    const { orderId } = req.params;
    const { voucherImageUrl } = req.body;

    if (!voucherImageUrl) {
      return res.status(400).json({ error: 'voucherImageUrl es requerido' });
    }

    const order = await getOrderById(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const business = await prisma.business.findFirst({
      where: {
        id: order.businessId,
        userId: req.userId
      }
    });

    if (!business) {
      return res.status(403).json({ error: 'No tienes acceso a este pedido' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        voucherImageUrl,
        voucherReceivedAt: new Date()
      },
      include: { items: true }
    });

    console.log(`[ORDERS] Voucher attached to order ${orderId}: ${voucherImageUrl}`);
    res.json(updatedOrder);
  } catch (error: any) {
    console.error('[ORDERS] Error attaching voucher:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:orderId/confirm-payment', authMiddleware, async (req: any, res) => {
  try {
    const { orderId } = req.params;

    const order = await getOrderById(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const business = await prisma.business.findFirst({
      where: {
        id: order.businessId,
        userId: req.userId
      }
    });

    if (!business) {
      return res.status(403).json({ error: 'No tienes acceso a este pedido' });
    }

    if (order.status !== 'AWAITING_VOUCHER') {
      return res.status(400).json({ error: 'Solo se pueden confirmar pedidos en estado AWAITING_VOUCHER' });
    }

    if (!order.voucherImageUrl) {
      return res.status(400).json({ error: 'No se ha recibido comprobante de pago para este pedido' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'PAID',
        paidAt: new Date()
      },
      include: { items: true }
    });

    console.log(`[ORDERS] Payment confirmed for order ${orderId}`);
    res.json(updatedOrder);
  } catch (error: any) {
    console.error('[ORDERS] Error confirming payment:', error);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/:orderId/status', authMiddleware, async (req: any, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const validStatuses = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Estado no válido' });
    }

    const order = await getOrderById(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const business = await prisma.business.findFirst({
      where: {
        id: order.businessId,
        userId: req.userId
      }
    });

    if (!business) {
      return res.status(403).json({ error: 'No tienes acceso a este pedido' });
    }

    const updatedOrder = await updateOrderStatus(orderId, status);
    res.json(updatedOrder);
  } catch (error: any) {
    console.error('[ORDERS] Error updating order status:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

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
      }
    });

    if (!business) {
      return res.status(403).json({ error: 'No tienes acceso a este negocio' });
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
      orderId: result.orderId
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

router.patch('/:orderId/status', authMiddleware, async (req: any, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const validStatuses = ['PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'];
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

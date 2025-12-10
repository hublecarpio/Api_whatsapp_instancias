import express from 'express';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { getDailyContactStats } from '../middleware/billing.js';
import { handlePaymentSuccess, handlePaymentCanceled } from '../services/stripePayments.js';

const router = express.Router();
const prisma = new PrismaClient();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

const PRICE_ID = (process.env.STRIPE_PRICE_WEEKLY_50 || '').trim();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5000';

router.post('/create-checkout-session', authMiddleware, async (req: any, res) => {
  try {
    if (!PRICE_ID) {
      console.error('STRIPE_PRICE_WEEKLY_50 is not configured');
      return res.status(500).json({ error: 'Stripe price not configured. Please contact support.' });
    }

    const userId = req.userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: user.id }
      });
      customerId = customer.id;

      await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId }
      });
    }

    console.log('Creating checkout session with price:', PRICE_ID);

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: PRICE_ID,
          quantity: 1
        }
      ],
      mode: 'subscription',
      subscription_data: {
        trial_period_days: 7
      },
      success_url: `${FRONTEND_URL}/dashboard?subscription=success`,
      cancel_url: `${FRONTEND_URL}/dashboard?subscription=canceled`,
      metadata: { userId: user.id }
    });

    res.json({ url: session.url });
  } catch (error: any) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Stripe webhook received: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        
        if (session.mode === 'payment' && session.metadata?.orderId) {
          const result = await handlePaymentSuccess(session.id);
          if (result.success && result.order) {
            console.log(`[BILLING WEBHOOK] Order ${result.order.id} payment completed`);
          } else {
            console.log(`[BILLING WEBHOOK] Payment session processed: ${session.id}`);
          }
        } else if (session.mode === 'subscription') {
          const userId = session.metadata?.userId;
          const subscriptionId = session.subscription as string;

          if (userId && subscriptionId) {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const trialEnd = subscription.trial_end 
              ? new Date(subscription.trial_end * 1000) 
              : null;

            await prisma.user.update({
              where: { id: userId },
              data: {
                stripeSubscriptionId: subscriptionId,
                subscriptionStatus: trialEnd ? 'TRIAL' : 'ACTIVE',
                trialEndAt: trialEnd
              }
            });
            console.log(`User ${userId} subscription activated: ${subscriptionId}`);
          }
        }
        break;
      }
      
      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.orderId) {
          await handlePaymentCanceled(session.id);
          console.log(`[BILLING WEBHOOK] Session expired, order canceled`);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionRef = (invoice as any).subscription;
        const subscriptionId = typeof subscriptionRef === 'string' 
          ? subscriptionRef 
          : subscriptionRef?.id;

        if (subscriptionId) {
          const user = await prisma.user.findFirst({
            where: { stripeSubscriptionId: subscriptionId }
          });

          if (user) {
            await prisma.user.update({
              where: { id: user.id },
              data: { 
                subscriptionStatus: 'ACTIVE',
                trialEndAt: null
              }
            });
            console.log(`User ${user.id} payment succeeded, status: ACTIVE`);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionRef = (invoice as any).subscription;
        const subscriptionId = typeof subscriptionRef === 'string' 
          ? subscriptionRef 
          : subscriptionRef?.id;

        if (subscriptionId) {
          const user = await prisma.user.findFirst({
            where: { stripeSubscriptionId: subscriptionId }
          });

          if (user) {
            await prisma.user.update({
              where: { id: user.id },
              data: { subscriptionStatus: 'PAST_DUE' }
            });
            console.log(`User ${user.id} payment failed, status: PAST_DUE`);
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;

        const user = await prisma.user.findFirst({
          where: { stripeSubscriptionId: subscription.id }
        });

        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: { 
              subscriptionStatus: 'CANCELED',
              stripeSubscriptionId: null
            }
          });
          console.log(`User ${user.id} subscription canceled`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        
        const user = await prisma.user.findFirst({
          where: { stripeSubscriptionId: subscription.id }
        });

        if (user) {
          let status: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' = 'ACTIVE';
          
          if (subscription.status === 'trialing') {
            status = 'TRIAL';
          } else if (subscription.status === 'past_due') {
            status = 'PAST_DUE';
          } else if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
            status = 'CANCELED';
          }

          await prisma.user.update({
            where: { id: user.id },
            data: { subscriptionStatus: status }
          });
          console.log(`User ${user.id} subscription updated to: ${status}`);
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (error: any) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/subscription-status', authMiddleware, async (req: any, res) => {
  try {
    const userId = req.userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let nextPayment: Date | null = null;

    if (user.stripeSubscriptionId) {
      try {
        const subscriptionData = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
        const periodEnd = (subscriptionData as any).current_period_end;
        if (periodEnd) {
          nextPayment = new Date(periodEnd * 1000);
        }
      } catch (err) {
        console.error('Error fetching subscription from Stripe:', err);
      }
    }

    res.json({
      subscriptionStatus: user.subscriptionStatus.toLowerCase(),
      trialEndAt: user.trialEndAt,
      nextPayment,
      hasSubscription: !!user.stripeSubscriptionId
    });
  } catch (error: any) {
    console.error('Error fetching subscription status:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/cancel-subscription', authMiddleware, async (req: any, res) => {
  try {
    const userId = req.userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.stripeSubscriptionId) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: true
    });

    res.json({ 
      success: true, 
      message: 'Subscription will be canceled at the end of the current billing period' 
    });
  } catch (error: any) {
    console.error('Error canceling subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/reactivate-subscription', authMiddleware, async (req: any, res) => {
  try {
    const userId = req.userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.stripeSubscriptionId) {
      return res.status(400).json({ error: 'No subscription found' });
    }

    await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: false
    });

    res.json({ 
      success: true, 
      message: 'Subscription reactivated successfully' 
    });
  } catch (error: any) {
    console.error('Error reactivating subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/contacts-today', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const businessId = req.query.businessId as string | undefined;
    const stats = await getDailyContactStats(userId, businessId);
    
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching daily contact stats:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/access-status', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const businessId = req.query.businessId as string | undefined;
    const contactStats = await getDailyContactStats(userId, businessId);

    const hasPaymentMethod = user.subscriptionStatus !== 'PENDING';
    const hasActiveSubscription = ['TRIAL', 'ACTIVE'].includes(user.subscriptionStatus);
    
    const canUseCrm = user.emailVerified === true;
    const canUseAi = hasActiveSubscription;
    const canAccess = canUseCrm;
    
    let daysRemaining: number | null = null;
    if (user.trialEndAt && user.subscriptionStatus === 'TRIAL') {
      const now = new Date();
      const trialEnd = new Date(user.trialEndAt);
      daysRemaining = Math.max(0, Math.ceil((trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    }

    res.json({
      emailVerified: user.emailVerified,
      hasPaymentMethod,
      hasActiveSubscription,
      canUseCrm,
      canUseAi,
      canAccess,
      subscriptionStatus: user.subscriptionStatus.toLowerCase(),
      trialEndAt: user.trialEndAt,
      trialDaysRemaining: daysRemaining,
      dailyContacts: contactStats
    });
  } catch (error: any) {
    console.error('Error fetching access status:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

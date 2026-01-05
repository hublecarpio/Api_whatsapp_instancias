import express from 'express';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { getDailyContactStats } from '../middleware/billing.js';
import { handlePaymentSuccess, handlePaymentCanceled } from '../services/stripePayments.js';
import { getMonthlyTokenUsageForUser, checkUserTokenLimit, TRIAL_TOKEN_LIMIT, BASIC_TOKEN_LIMIT, PRO_TOKEN_LIMIT } from '../services/openaiService.js';
import { sendEmail } from '../services/emailService.js';

const router = express.Router();
const prisma = new PrismaClient();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

const PRICE_ID_WEEKLY = (process.env.STRIPE_PRICE_WEEKLY_50 || '').trim();
const PRICE_ID_MONTHLY = (process.env.STRIPE_PRICE_MONTHLY_97 || '').trim();
const PRICE_ID_BASIC = (process.env.STRIPE_PRICE_BASIC_29 || '').trim();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5000';

const PLAN_CONFIG: Record<string, { priceId: string; tier: 'BASIC' | 'PRO'; name: string; price: number; tokens: string }> = {
  BASIC: {
    priceId: PRICE_ID_BASIC,
    tier: 'BASIC',
    name: 'Plan Basic',
    price: 29,
    tokens: '1.6M'
  },
  PRO: {
    priceId: PRICE_ID_MONTHLY,
    tier: 'PRO', 
    name: 'Plan Pro',
    price: 97,
    tokens: '5M'
  }
};

router.post('/create-checkout-session', authMiddleware, async (req: any, res) => {
  try {
    const { plan = 'BASIC' } = req.body;
    const planConfig = PLAN_CONFIG[plan.toUpperCase()];
    
    if (!planConfig) {
      return res.status(400).json({ error: 'Invalid plan. Choose BASIC or PRO.' });
    }
    
    const priceId = planConfig.priceId;
    
    if (!priceId) {
      console.error(`No Stripe price ID configured for plan: ${plan}`);
      return res.status(500).json({ error: `Stripe price not configured for ${plan} plan. Please contact support.` });
    }

    const userId = req.userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Validate: reject only if user has an active Stripe subscription with payment
    // Users in free trial (no Stripe subscription) CAN create a checkout session
    if (user.stripeSubscriptionId) {
      try {
        const existingSubscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
        if (['active', 'trialing', 'past_due'].includes(existingSubscription.status)) {
          return res.status(400).json({ 
            error: 'Ya tienes una suscripción activa. Para cambiar de plan, usa la opción de upgrade.',
            hasActiveSubscription: true
          });
        }
        // Subscription exists but is canceled/inactive - allow new checkout
      } catch (stripeError: any) {
        // If subscription doesn't exist in Stripe, clear local reference and allow checkout
        if (stripeError.code === 'resource_missing') {
          await prisma.user.update({
            where: { id: userId },
            data: { stripeSubscriptionId: null, subscriptionStatus: 'PENDING' }
          });
        } else {
          // For any other Stripe error (network, auth, etc.), reject to be safe
          console.error('Stripe error checking subscription:', stripeError.message);
          return res.status(503).json({ 
            error: 'No se pudo verificar el estado de tu suscripción. Intenta de nuevo.',
            retryable: true
          });
        }
      }
    }
    // Note: Users in TRIAL status without stripeSubscriptionId are allowed to checkout
    // This enables free trial users to subscribe with a card

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

    // Base trial with card is 7 days + any bonus trial days from referral code
    const baseTrialDays = 7;
    const bonusTrialDays = user.bonusTrialDays || 0;
    const totalTrialDays = baseTrialDays + bonusTrialDays;
    
    console.log(`Creating checkout session with plan: ${plan}, price: ${priceId}, trialDays: ${totalTrialDays}`);

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      mode: 'subscription',
      subscription_data: {
        trial_period_days: totalTrialDays,
        metadata: { tier: planConfig.tier }
      },
      success_url: `${FRONTEND_URL}/dashboard?subscription=success&plan=${plan}`,
      cancel_url: `${FRONTEND_URL}/dashboard?subscription=canceled`,
      metadata: { userId: user.id, tier: planConfig.tier }
    });

    res.json({ url: session.url });
  } catch (error: any) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

const processedWebhookEvents: Set<string> = new Set();
const WEBHOOK_EVENT_TTL = 5 * 60 * 1000;

// Only 3 user tiers: BASIC (default), PRO, ENTERPRISE
const TIER_PRIORITY: Record<string, number> = {
  BASIC: 1,
  PRO: 2,
  ENTERPRISE: 3
};

function getTierFromPriceId(priceId: string): 'BASIC' | 'PRO' | 'ENTERPRISE' {
  if (priceId === PRICE_ID_BASIC) return 'BASIC';
  if (priceId === PRICE_ID_MONTHLY || priceId === PRICE_ID_WEEKLY) return 'PRO';
  return 'BASIC';
}

function shouldUpdateTier(currentTier: string | null, newTier: string): boolean {
  // Never downgrade ENTERPRISE (manually assigned)
  if (currentTier === 'ENTERPRISE') return false;
  // Allow upgrade or if current tier is null/unknown (default to BASIC priority)
  const currentPriority = TIER_PRIORITY[currentTier || 'BASIC'] || 1;
  const newPriority = TIER_PRIORITY[newTier] || 1;
  return newPriority >= currentPriority;
}

setInterval(() => {
  processedWebhookEvents.clear();
}, WEBHOOK_EVENT_TTL);

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

  if (processedWebhookEvents.has(event.id)) {
    console.log(`Stripe webhook already processed: ${event.id}`);
    return res.json({ received: true, duplicate: true });
  }
  
  processedWebhookEvents.add(event.id);
  console.log(`Stripe webhook received: ${event.type} (${event.id})`);

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
          const tierFromMetadata = session.metadata?.tier as 'BASIC' | 'PRO' | undefined;

          if (userId && subscriptionId) {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const trialEnd = subscription.trial_end 
              ? new Date(subscription.trial_end * 1000) 
              : null;
            
            const priceId = subscription.items.data[0]?.price?.id || '';
            const stripeTier = tierFromMetadata || getTierFromPriceId(priceId);
            
            // Check current user tier to avoid downgrading ENTERPRISE
            const currentUser = await prisma.user.findUnique({ where: { id: userId }, select: { subscriptionTier: true } });
            const finalTier = (currentUser && !shouldUpdateTier(currentUser.subscriptionTier, stripeTier)) 
              ? currentUser.subscriptionTier 
              : stripeTier;

            await prisma.user.update({
              where: { id: userId },
              data: {
                stripeSubscriptionId: subscriptionId,
                subscriptionStatus: trialEnd ? 'TRIAL' : 'ACTIVE',
                subscriptionTier: finalTier,
                trialEndAt: trialEnd,
                demoPhase: 'TRIAL'
              }
            });
            console.log(`User ${userId} subscription activated: ${subscriptionId}, tier: ${finalTier}${finalTier !== stripeTier ? ' (preserved ENTERPRISE)' : ''}, demoPhase set to TRIAL`);
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
    let user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let nextPayment: Date | null = null;
    let syncedFromStripe = false;

    // AUTO-SYNC: If user has stripeCustomerId but no stripeSubscriptionId, check Stripe for active subscriptions
    if (user.stripeCustomerId && !user.stripeSubscriptionId) {
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: user.stripeCustomerId,
          status: 'all',
          limit: 1
        });
        
        if (subscriptions.data.length > 0) {
          const latestSub = subscriptions.data[0];
          if (['active', 'trialing'].includes(latestSub.status)) {
            const trialEnd = latestSub.trial_end ? new Date(latestSub.trial_end * 1000) : null;
            const priceId = latestSub.items.data[0]?.price?.id || '';
            const stripeTier = getTierFromPriceId(priceId);
            
            // Only update tier if not a downgrade (preserve ENTERPRISE)
            const newTier = shouldUpdateTier(user.subscriptionTier, stripeTier) ? stripeTier : user.subscriptionTier;
            
            user = await prisma.user.update({
              where: { id: userId },
              data: {
                stripeSubscriptionId: latestSub.id,
                subscriptionStatus: trialEnd && trialEnd > new Date() ? 'TRIAL' : 'ACTIVE',
                subscriptionTier: newTier,
                trialEndAt: trialEnd,
                demoPhase: 'TRIAL'
              }
            });
            
            console.log(`[AUTO-SYNC] User ${userId} subscription synced from Stripe: ${latestSub.id}, tier: ${newTier}${newTier !== stripeTier ? ' (preserved from ' + user.subscriptionTier + ')' : ''}`);
            syncedFromStripe = true;
          }
        }
      } catch (err) {
        console.error('Error auto-syncing subscription from Stripe:', err);
      }
    }

    if (user.stripeSubscriptionId) {
      try {
        const subscriptionData = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
        const periodEnd = (subscriptionData as any).current_period_end;
        if (periodEnd) {
          nextPayment = new Date(periodEnd * 1000);
        }
        
        // Sync tier if subscription exists but tier seems wrong (never downgrade ENTERPRISE)
        if (['active', 'trialing'].includes(subscriptionData.status)) {
          const priceId = subscriptionData.items.data[0]?.price?.id || '';
          const correctTier = getTierFromPriceId(priceId);
          if (user.subscriptionTier !== correctTier && shouldUpdateTier(user.subscriptionTier, correctTier)) {
            const oldTier = user.subscriptionTier;
            user = await prisma.user.update({
              where: { id: userId },
              data: { subscriptionTier: correctTier }
            });
            console.log(`[TIER-SYNC] User ${userId} tier updated: ${oldTier} -> ${correctTier}`);
            syncedFromStripe = true;
          } else if (user.subscriptionTier === 'ENTERPRISE') {
            console.log(`[TIER-SYNC] User ${userId} preserved ENTERPRISE tier (manually assigned)`);
          }
        }
      } catch (err) {
        console.error('Error fetching subscription from Stripe:', err);
      }
    }

    const hasActiveBonus = user.proBonusExpiresAt && user.proBonusExpiresAt > new Date();
    
    // Check if trial without card has expired
    const now = new Date();
    const isTrialExpired = user.trialEndAt && user.trialEndAt < now && !user.stripeSubscriptionId;
    const daysRemaining = user.trialEndAt 
      ? Math.max(0, Math.ceil((user.trialEndAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
      : null;
    
    // Determine effective status - if trial expired and no subscription, they're suspended
    let effectiveStatus = user.subscriptionStatus.toLowerCase();
    if (isTrialExpired && effectiveStatus === 'trial') {
      effectiveStatus = 'expired';
      // Update user status in DB
      await prisma.user.update({
        where: { id: userId },
        data: { subscriptionStatus: 'PENDING' }
      });
    }
    
    res.json({
      subscriptionStatus: effectiveStatus,
      trialEndAt: user.trialEndAt,
      daysRemaining,
      isTrialExpired,
      nextPayment,
      hasSubscription: !!user.stripeSubscriptionId,
      proBonusExpiresAt: user.proBonusExpiresAt,
      hasActiveBonus,
      subscriptionTier: user.subscriptionTier,
      syncedFromStripe
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

// Upgrade subscription from BASIC to PRO
router.post('/upgrade-subscription', authMiddleware, async (req: any, res) => {
  try {
    const userId = req.userId;
    const { targetPlan = 'PRO' } = req.body;
    
    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (!user.stripeSubscriptionId) {
      return res.status(400).json({ error: 'No hay suscripcion activa para actualizar' });
    }
    
    const planConfig = PLAN_CONFIG[targetPlan.toUpperCase()];
    if (!planConfig) {
      return res.status(400).json({ error: 'Plan invalido' });
    }
    
    // Get current subscription
    const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    
    if (!['active', 'trialing'].includes(subscription.status)) {
      return res.status(400).json({ error: 'La suscripcion no esta activa' });
    }
    
    // Get current price to check if it's different
    const currentPriceId = subscription.items.data[0]?.price.id;
    if (currentPriceId === planConfig.priceId) {
      return res.status(400).json({ error: 'Ya tienes este plan activo' });
    }
    
    // Update the subscription to the new plan
    await stripe.subscriptions.update(user.stripeSubscriptionId, {
      items: [{
        id: subscription.items.data[0].id,
        price: planConfig.priceId,
      }],
      proration_behavior: 'create_prorations', // Pro-rate the difference
      metadata: { tier: planConfig.tier }
    });
    
    // Update user record
    await prisma.user.update({
      where: { id: userId },
      data: { subscriptionTier: planConfig.tier }
    });
    
    console.log(`[BILLING] User ${userId} upgraded to ${planConfig.tier}`);
    
    res.json({ 
      success: true, 
      message: `Plan actualizado a ${planConfig.name}`,
      newTier: planConfig.tier
    });
  } catch (error: any) {
    console.error('Error upgrading subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

export async function pauseStripeSubscription(userId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    if (!user || !user.stripeSubscriptionId) {
      return { success: false, error: 'No active subscription' };
    }

    await stripe.subscriptions.update(user.stripeSubscriptionId, {
      pause_collection: {
        behavior: 'void'
      }
    });

    await prisma.user.update({
      where: { id: userId },
      data: { stripePausedAt: new Date() }
    });

    console.log(`[BILLING] Paused Stripe subscription for user ${userId}`);
    return { success: true };
  } catch (error: any) {
    console.error('[BILLING] Error pausing subscription:', error);
    return { success: false, error: error.message };
  }
}

export async function resumeStripeSubscription(userId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    if (!user || !user.stripeSubscriptionId) {
      return { success: false, error: 'No subscription to resume' };
    }

    await stripe.subscriptions.update(user.stripeSubscriptionId, {
      pause_collection: null as any
    });

    await prisma.user.update({
      where: { id: userId },
      data: { stripePausedAt: null }
    });

    console.log(`[BILLING] Resumed Stripe subscription for user ${userId}`);
    return { success: true };
  } catch (error: any) {
    console.error('[BILLING] Error resuming subscription:', error);
    return { success: false, error: error.message };
  }
}

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
    
    const tokenCheck = await checkUserTokenLimit(userId);
    const canUseAi = tokenCheck.canUseAI;
    const canAccess = canUseCrm;
    
    let daysRemaining: number | null = null;
    if (user.trialEndAt && user.subscriptionStatus === 'TRIAL') {
      const now = new Date();
      const trialEnd = new Date(user.trialEndAt);
      daysRemaining = Math.max(0, Math.ceil((trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    }

    const tokenUsage = user.subscriptionStatus === 'TRIAL' 
      ? await getMonthlyTokenUsageForUser(userId)
      : null;

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
      dailyContacts: contactStats,
      tokenUsage: tokenUsage ? {
        tokensUsed: tokenUsage.totalTokens,
        tokenLimit: tokenUsage.limit,
        percentUsed: tokenUsage.percentUsed,
        isOverLimit: tokenUsage.isOverLimit,
        message: tokenCheck.message
      } : null
    });
  } catch (error: any) {
    console.error('Error fetching access status:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/token-usage', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await prisma.user.findUnique({ 
      where: { id: userId },
      select: { subscriptionStatus: true, subscriptionTier: true, bonusTokens: true }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const tier = user.subscriptionTier || 'BASIC';
    const tokenUsage = await getMonthlyTokenUsageForUser(userId, user.subscriptionStatus, tier, user.bonusTokens);
    const tokenCheck = await checkUserTokenLimit(userId);

    res.json({
      tokensUsed: tokenUsage.totalTokens,
      tokenLimit: tokenUsage.limit,
      baseLimit: tokenUsage.baseLimit,
      bonusTokens: tokenUsage.bonusTokens,
      percentUsed: tokenUsage.percentUsed,
      isOverLimit: tokenUsage.isOverLimit,
      canUseAI: tokenCheck.canUseAI,
      tokensRemaining: tokenCheck.tokensRemaining,
      message: tokenCheck.message,
      subscriptionStatus: user.subscriptionStatus.toLowerCase(),
      subscriptionTier: tier
    });
  } catch (error: any) {
    console.error('Error fetching token usage:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/portal', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: 'No tienes un perfil de facturacion. Inicia una suscripcion primero.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${FRONTEND_URL}/dashboard/billing`
    });

    res.json({ url: session.url });
  } catch (error: any) {
    console.error('Error creating billing portal session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Token credits pricing - designed to be slightly more expensive than plan rates
// so plans remain attractive, but affordable for occasional top-ups
// BASIC: $29/1.6M = $18.12/M, PRO: $97/7.5M = $12.93/M
// Credits: ~$16-17/M (premium for convenience)
const TOKEN_CREDIT_OPTIONS: { [key: number]: { amount: number; tokens: number } } = {
  5: { amount: 500, tokens: 300000 },    // $5 = 300K tokens (~$16.67/M)
  10: { amount: 1000, tokens: 600000 },  // $10 = 600K tokens (~$16.67/M)
  15: { amount: 1500, tokens: 1000000 }  // $15 = 1M tokens ($15/M - small volume discount)
};

const purchaseInProgress: Set<string> = new Set();

router.post('/purchase-credits', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (purchaseInProgress.has(userId)) {
      return res.status(429).json({ error: 'Ya hay una compra en proceso. Espera un momento.' });
    }

    purchaseInProgress.add(userId);

    try {
      const { tier = 5 } = req.body;
      
      const creditOption = TOKEN_CREDIT_OPTIONS[tier as number];
      if (!creditOption) {
        return res.status(400).json({ error: 'Opcion de creditos invalida. Usa 5, 10 o 15.' });
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (user.subscriptionStatus !== 'ACTIVE') {
        return res.status(400).json({ error: 'Solo usuarios con suscripcion activa pueden comprar creditos adicionales.' });
      }

      if (!user.stripeCustomerId) {
        return res.status(400).json({ error: 'No tienes un metodo de pago configurado.' });
      }

      const paymentMethods = await stripe.paymentMethods.list({
        customer: user.stripeCustomerId,
        type: 'card'
      });

      if (paymentMethods.data.length === 0) {
        return res.status(400).json({ error: 'No tienes una tarjeta guardada. Actualiza tu metodo de pago primero.' });
      }

      const defaultPaymentMethod = paymentMethods.data[0].id;

      const idempotencyKey = `token_credits_${userId}_${Date.now()}`;

      const paymentIntent = await stripe.paymentIntents.create({
        amount: creditOption.amount,
        currency: 'usd',
        customer: user.stripeCustomerId,
        payment_method: defaultPaymentMethod,
        off_session: true,
        confirm: true,
        description: `Token Credits: ${(creditOption.tokens / 1000000).toFixed(0)}M tokens`,
        metadata: {
          userId: user.id,
          type: 'token_credits',
          tokens: creditOption.tokens.toString(),
          tier: tier.toString()
        }
      }, {
        idempotencyKey
      });

      if (paymentIntent.status === 'succeeded') {
        await prisma.user.update({
          where: { id: userId },
          data: {
            bonusTokens: {
              increment: creditOption.tokens
            }
          }
        });

        const updatedUser = await prisma.user.findUnique({
          where: { id: userId },
          select: { bonusTokens: true }
        });

        console.log(`Token credits purchased: ${creditOption.tokens} tokens ($${tier}) for user ${user.email}, PaymentIntent: ${paymentIntent.id}`);

        res.json({
          success: true,
          message: `Se agregaron ${(creditOption.tokens / 1000000).toFixed(0)}M tokens a tu cuenta.`,
          tokensAdded: creditOption.tokens,
          newBonusTotal: updatedUser?.bonusTokens || 0,
          amountCharged: creditOption.amount / 100
        });
      } else {
        res.status(400).json({ error: 'El pago no pudo ser procesado. Intenta de nuevo.' });
      }
    } finally {
      purchaseInProgress.delete(userId);
    }
  } catch (error: any) {
    console.error('Error purchasing token credits:', error);
    purchaseInProgress.delete(req.userId || '');
    
    if (error.type === 'StripeCardError') {
      return res.status(400).json({ error: 'Tu tarjeta fue rechazada. Actualiza tu metodo de pago.' });
    }
    
    res.status(500).json({ error: error.message });
  }
});

router.post('/enterprise-request', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await prisma.user.findUnique({ 
      where: { id: userId },
      include: { businesses: { select: { name: true } } }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { businessDescription, companySize, useCase } = req.body;

    if (!businessDescription) {
      return res.status(400).json({ error: 'Descripcion del negocio es requerida' });
    }

    const businessNames = user.businesses.map(b => b.name).join(', ') || 'Sin negocios registrados';
    const enterpriseEmail = 'iam@hubleconsulting.com';

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9f9f9; padding: 20px; border-radius: 0 0 8px 8px; }
    .field { margin-bottom: 15px; }
    .label { font-weight: bold; color: #555; }
    .value { background: white; padding: 10px; border-radius: 4px; margin-top: 5px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Nueva Solicitud Enterprise</h1>
      <p>Un usuario ha solicitado el plan Enterprise ($400/mes)</p>
    </div>
    <div class="content">
      <div class="field">
        <div class="label">Usuario</div>
        <div class="value">${user.name} (${user.email})</div>
      </div>
      <div class="field">
        <div class="label">ID de Usuario</div>
        <div class="value">${user.id}</div>
      </div>
      <div class="field">
        <div class="label">Negocios Registrados</div>
        <div class="value">${businessNames}</div>
      </div>
      <div class="field">
        <div class="label">Suscripcion Actual</div>
        <div class="value">${user.subscriptionStatus}</div>
      </div>
      <div class="field">
        <div class="label">Tamano de Empresa</div>
        <div class="value">${companySize || 'No especificado'}</div>
      </div>
      <div class="field">
        <div class="label">Caso de Uso</div>
        <div class="value">${useCase || 'No especificado'}</div>
      </div>
      <div class="field">
        <div class="label">Descripcion del Negocio</div>
        <div class="value">${businessDescription}</div>
      </div>
      <div class="field">
        <div class="label">Fecha de Solicitud</div>
        <div class="value">${new Date().toLocaleString('es-ES', { timeZone: 'America/Lima' })}</div>
      </div>
    </div>
  </div>
</body>
</html>
    `;

    const emailSent = await sendEmail(
      enterpriseEmail,
      `[Enterprise Request] Nueva solicitud de ${user.name}`,
      emailHtml
    );

    if (!emailSent) {
      console.error('Failed to send enterprise request email');
    }

    console.log(`[BILLING] Enterprise request from user ${user.id} (${user.email})`);

    res.json({ 
      success: true, 
      message: 'Tu solicitud ha sido enviada. Nuestro equipo se pondra en contacto contigo pronto para coordinar la auditoria y configuracion.' 
    });
  } catch (error: any) {
    console.error('Error processing enterprise request:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/plans', async (_req, res) => {
  const plans = [
    {
      id: 'BASIC',
      name: 'Plan Basic',
      price: 29,
      currency: 'USD',
      interval: 'month',
      tokens: '1.6M',
      tokenLimit: BASIC_TOKEN_LIMIT,
      features: [
        'Agente IA ilimitado',
        '1.6M tokens/mes',
        'WhatsApp Web + Meta Cloud API',
        'CRM de contactos',
        'Productos y catalogo',
        'Broadcast masivo',
        'Soporte por email'
      ],
      excluded: ['Webhooks', 'API Keys'],
      available: !!PRICE_ID_BASIC
    },
    {
      id: 'PRO',
      name: 'Plan Pro',
      price: 97,
      currency: 'USD',
      interval: 'month',
      tokens: '5M',
      tokenLimit: PRO_TOKEN_LIMIT,
      features: [
        'Todo lo del plan Basic',
        '5M tokens/mes',
        'Webhooks personalizados',
        'API Keys para integraciones',
        'Soporte prioritario'
      ],
      excluded: [],
      available: !!PRICE_ID_MONTHLY,
      recommended: true
    }
  ];

  res.json({ plans });
});

export default router;

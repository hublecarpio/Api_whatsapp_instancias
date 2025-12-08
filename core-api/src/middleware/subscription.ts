import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function subscriptionMiddleware(req: any, res: Response, next: NextFunction) {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const status = user.subscriptionStatus;

    if (status === 'TRIAL') {
      if (user.trialEndAt && new Date() > user.trialEndAt) {
        return res.status(403).json({ 
          error: 'Trial expired',
          code: 'TRIAL_EXPIRED',
          message: 'Your trial has expired. Please subscribe to continue using the service.'
        });
      }
      return next();
    }

    if (status === 'ACTIVE') {
      return next();
    }

    if (status === 'PAST_DUE') {
      return res.status(403).json({ 
        error: 'Payment required',
        code: 'PAYMENT_REQUIRED',
        message: 'Your payment is past due. Please update your payment method to continue.'
      });
    }

    if (status === 'CANCELED') {
      return res.status(403).json({ 
        error: 'Subscription canceled',
        code: 'SUBSCRIPTION_CANCELED',
        message: 'Your subscription has been canceled. Please subscribe to continue.'
      });
    }

    if (status === 'PENDING') {
      return res.status(403).json({ 
        error: 'Subscription required',
        code: 'SUBSCRIPTION_REQUIRED',
        message: 'Please complete your subscription to access this feature.'
      });
    }

    return res.status(403).json({ 
      error: 'Access denied',
      code: 'ACCESS_DENIED',
      message: 'Unable to verify subscription status.'
    });
  } catch (error: any) {
    console.error('Subscription middleware error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function optionalSubscriptionCheck(req: any, res: Response, next: NextFunction) {
  try {
    if (!req.user || !req.user.id) {
      req.subscriptionStatus = null;
      return next();
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user) {
      req.subscriptionStatus = null;
      return next();
    }

    req.subscriptionStatus = user.subscriptionStatus;
    req.subscriptionActive = 
      user.subscriptionStatus === 'ACTIVE' || 
      (user.subscriptionStatus === 'TRIAL' && (!user.trialEndAt || new Date() <= user.trialEndAt));

    return next();
  } catch (error: any) {
    console.error('Optional subscription check error:', error);
    req.subscriptionStatus = null;
    return next();
  }
}

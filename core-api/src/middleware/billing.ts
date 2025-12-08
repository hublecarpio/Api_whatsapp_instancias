import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from './auth.js';

const prisma = new PrismaClient();

const MAX_DAILY_CONTACTS = 50;

export async function requirePaymentMethod(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.subscriptionStatus === 'PENDING') {
      return res.status(402).json({ 
        error: 'Payment method required',
        code: 'PAYMENT_REQUIRED',
        message: 'Please add a payment method to continue using the platform'
      });
    }

    next();
  } catch (error: any) {
    console.error('Error in requirePaymentMethod middleware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function requireActiveSubscription(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const validStatuses = ['TRIAL', 'ACTIVE'];
    
    if (!validStatuses.includes(user.subscriptionStatus)) {
      return res.status(402).json({ 
        error: 'Active subscription required',
        code: 'SUBSCRIPTION_REQUIRED',
        status: user.subscriptionStatus.toLowerCase(),
        message: user.subscriptionStatus === 'PENDING' 
          ? 'Please add a payment method to start your free trial'
          : user.subscriptionStatus === 'PAST_DUE'
          ? 'Your payment is overdue. Please update your payment method.'
          : 'Your subscription has been canceled. Please reactivate to continue.'
      });
    }

    next();
  } catch (error: any) {
    console.error('Error in requireActiveSubscription middleware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function checkDailyContactLimit(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const businessId = req.body.business_id || req.params.businessId;
    
    if (!businessId) {
      return next();
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const uniqueContacts = await prisma.messageLog.groupBy({
      by: ['recipient'],
      where: {
        businessId,
        direction: 'outbound',
        createdAt: {
          gte: today,
          lt: tomorrow
        },
        recipient: {
          not: null
        }
      }
    });

    const contactCount = uniqueContacts.length;
    const phone = req.body.phone || req.body.phoneNumber;

    if (phone) {
      const normalizedPhone = phone.replace('@s.whatsapp.net', '').replace('@lid', '').replace(/\D/g, '');
      const isExistingContact = uniqueContacts.some(
        c => c.recipient?.replace(/\D/g, '') === normalizedPhone
      );
      
      if (!isExistingContact && contactCount >= MAX_DAILY_CONTACTS) {
        return res.status(429).json({
          error: 'Daily contact limit reached',
          code: 'DAILY_LIMIT_REACHED',
          limit: MAX_DAILY_CONTACTS,
          current: contactCount,
          message: `You have reached the maximum of ${MAX_DAILY_CONTACTS} new contacts per day. Try again tomorrow.`
        });
      }
    }

    (req as any).dailyContactCount = contactCount;
    (req as any).dailyContactLimit = MAX_DAILY_CONTACTS;
    
    next();
  } catch (error: any) {
    console.error('Error in checkDailyContactLimit middleware:', error);
    next();
  }
}

export async function getDailyContactStats(userId: string, businessId?: string): Promise<{
  count: number;
  limit: number;
  remaining: number;
}> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  let targetBusinessId = businessId;
  
  if (!targetBusinessId) {
    const business = await prisma.business.findFirst({
      where: { userId },
      select: { id: true }
    });
    targetBusinessId = business?.id;
  }

  if (!targetBusinessId) {
    return { count: 0, limit: MAX_DAILY_CONTACTS, remaining: MAX_DAILY_CONTACTS };
  }

  const uniqueContacts = await prisma.messageLog.groupBy({
    by: ['recipient'],
    where: {
      businessId: targetBusinessId,
      direction: 'outbound',
      createdAt: {
        gte: today,
        lt: tomorrow
      },
      recipient: {
        not: null
      }
    }
  });

  const count = uniqueContacts.length;
  
  return {
    count,
    limit: MAX_DAILY_CONTACTS,
    remaining: Math.max(0, MAX_DAILY_CONTACTS - count)
  };
}

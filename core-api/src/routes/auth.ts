import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../services/prisma.js';
import { authMiddleware, generateToken, AuthRequest } from '../middleware/auth.js';
import { generateVerificationToken, hashToken, sendVerificationEmail, sendPasswordResetEmail, testSMTPConnection } from '../services/emailService.js';
import { pauseStripeSubscription, resumeStripeSubscription } from './billing.js';
import { isGoogleAuthConfigured, getGoogleAuthUrl, getGoogleUserInfo } from '../services/googleAuth.js';

const router = Router();

const APP_DOMAIN = process.env.APP_DOMAIN || process.env.FRONTEND_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;
const VERIFICATION_TOKEN_EXPIRY_HOURS = 24;
const PASSWORD_RESET_EXPIRY_HOURS = 1;
const RESEND_THROTTLE_MINUTES = 2;

router.post('/register', async (req: Request, res: Response) => {
  try {
    const { name, businessName, email, password, phone, referralCode } = req.body;
    
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    
    // Clean phone number if provided
    const cleanPhone = phone ? phone.replace(/\D/g, '') : null;
    
    const finalBusinessName = businessName?.trim() || 'Mi Empresa';
    
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    
    let validReferralCode: string | null = null;
    let enterpriseCode: any = null;
    let standardCode: any = null;
    
    if (referralCode) {
      const refCode = await prisma.referralCode.findUnique({
        where: { code: referralCode.toUpperCase() }
      });
      
      if (refCode && refCode.isActive) {
        if (!refCode.expiresAt || refCode.expiresAt > new Date()) {
          if (refCode.maxUses && refCode.usageCount >= refCode.maxUses) {
            console.log(`[REFERRAL] Code max uses reached: ${refCode.code}`);
          } else {
            validReferralCode = refCode.code;
            
            await prisma.referralCode.update({
              where: { id: refCode.id },
              data: { usageCount: { increment: 1 } }
            });
            
            if (refCode.type === 'ENTERPRISE' && refCode.grantDurationDays) {
              enterpriseCode = refCode;
              console.log(`[REFERRAL] Enterprise code used: ${refCode.code} (${refCode.grantDurationDays} days, tier: ${refCode.grantTier})`);
            } else {
              standardCode = refCode;
              const bonusDemo = refCode.bonusDemoDays || 0;
              const bonusTrial = refCode.bonusTrialDays || 0;
              console.log(`[REFERRAL] Valid code used: ${refCode.code}, new count: ${refCode.usageCount + 1}, bonusDemoDays: ${bonusDemo}, bonusTrialDays: ${bonusTrial}`);
            }
          }
        } else {
          console.log(`[REFERRAL] Expired code attempted: ${referralCode}`);
        }
      } else {
        console.log(`[REFERRAL] Invalid or inactive code attempted: ${referralCode}`);
      }
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    const rawToken = generateVerificationToken();
    const hashedToken = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);
    
    const result = await prisma.$transaction(async (tx) => {
      const isPro = !!enterpriseCode;
      const subscriptionStatus = enterpriseCode ? 'ACTIVE' : 'TRIAL';
      
      // Get the referral code ID for FK relation
      const referralCodeRecord = enterpriseCode || standardCode;
      const bonusDemoDays = standardCode?.bonusDemoDays || 0;
      const bonusTrialDays = standardCode?.bonusTrialDays || 0;
      
      // Trial sin tarjeta: 2 días base + bonusDemoDays del código de referido
      const baseDemoDays = 2;
      const totalDemoDays = baseDemoDays + bonusDemoDays;
      const trialEndAt = enterpriseCode ? null : new Date(Date.now() + totalDemoDays * 24 * 60 * 60 * 1000);
      
      const user = await tx.user.create({
        data: { 
          name, 
          email,
          phone: cleanPhone,
          passwordHash,
          emailVerified: false,
          verificationToken: hashedToken,
          verificationTokenExpiresAt: expiresAt,
          lastVerificationSentAt: new Date(),
          referralCode: validReferralCode,
          referralCodeId: referralCodeRecord?.id || null,
          bonusDemoDays,
          bonusTrialDays,
          isPro,
          subscriptionStatus,
          subscriptionTier: 'BASIC', // Default tier for trial users
          trialEndAt, // 2 días + bonus para trial sin tarjeta
          demoStartedAt: enterpriseCode ? null : new Date(),
          demoPhase: enterpriseCode ? 'ACTIVE' : 'DEMO'
        }
      });
      
      if (enterpriseCode) {
        const now = new Date();
        const subscriptionEndsAt = new Date(now.getTime() + enterpriseCode.grantDurationDays * 24 * 60 * 60 * 1000);
        
        await tx.subscription.create({
          data: {
            userId: user.id,
            source: 'ENTERPRISE',
            tier: enterpriseCode.grantTier || 'PRO',
            status: 'ACTIVE',
            startsAt: now,
            endsAt: subscriptionEndsAt,
            referralCodeId: enterpriseCode.id,
            activatedBy: 'referral_code',
            notes: `Auto-activated via enterprise code: ${enterpriseCode.code}`
          }
        });
        
        console.log(`[ENTERPRISE] User ${email} activated with PRO for ${enterpriseCode.grantDurationDays} days via code ${enterpriseCode.code}`);
      }
      
      const business = await tx.business.create({
        data: {
          userId: user.id,
          name: finalBusinessName,
          description: 'Configura los datos de tu empresa',
          botEnabled: true
        }
      });
      
      console.log(`Created starter business ${business.id} for user ${user.id}`);
      
      return { user, business, isPro };
    });
    
    await sendVerificationEmail(email, name, rawToken, APP_DOMAIN);
    
    const token = generateToken(result.user.id);
    
    res.status(201).json({
      user: { 
        id: result.user.id, 
        name: result.user.name, 
        email: result.user.email,
        emailVerified: false,
        isPro: result.isPro
      },
      token,
      message: result.isPro 
        ? 'Registration successful! Your PRO subscription has been activated. Please check your email to verify your account.'
        : 'Registration successful. Please check your email to verify your account.'
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.get('/check-referral/:code', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    
    const refCode = await prisma.referralCode.findUnique({
      where: { code: code.toUpperCase() }
    });
    
    if (!refCode || !refCode.isActive) {
      return res.json({ valid: false });
    }
    
    if (refCode.expiresAt && refCode.expiresAt < new Date()) {
      return res.json({ valid: false, reason: 'expired' });
    }
    
    if (refCode.maxUses && refCode.usageCount >= refCode.maxUses) {
      return res.json({ valid: false, reason: 'max_uses_reached' });
    }
    
    res.json({ 
      valid: true, 
      code: refCode.code,
      description: refCode.description,
      type: refCode.type,
      grantsPro: refCode.type === 'ENTERPRISE',
      grantDurationDays: refCode.grantDurationDays,
      bonusDemoDays: refCode.bonusDemoDays || 0,
      bonusTrialDays: refCode.bonusTrialDays || 0,
      totalDemoDays: 2 + (refCode.bonusDemoDays || 0),
      totalTrialDays: 5 + (refCode.bonusTrialDays || 0)
    });
  } catch (error) {
    console.error('Check referral error:', error);
    res.json({ valid: false });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = generateToken(user.id);
    
    res.json({
      user: { 
        id: user.id, 
        name: user.name, 
        email: user.email,
        emailVerified: user.emailVerified,
        isPro: user.isPro,
        paymentLinkEnabled: user.paymentLinkEnabled,
        role: user.role,
        parentUserId: user.parentUserId
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/verify-email', async (req: Request, res: Response) => {
  try {
    const { token } = req.query;
    
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Invalid verification token' });
    }
    
    const hashedToken = hashToken(token);
    
    const user = await prisma.user.findFirst({
      where: {
        verificationToken: hashedToken,
        verificationTokenExpiresAt: { gte: new Date() }
      }
    });
    
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }
    
    if (user.emailVerified) {
      return res.json({ success: true, message: 'Email already verified' });
    }
    
    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        verificationToken: null,
        verificationTokenExpiresAt: null
      }
    });
    
    console.log(`Email verified for user ${user.id}`);
    
    res.json({ success: true, message: 'Email verified successfully' });
  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

router.post('/resend-verification', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.emailVerified) {
      return res.status(400).json({ error: 'Email already verified' });
    }
    
    if (user.lastVerificationSentAt) {
      const minutesSinceLastSent = (Date.now() - user.lastVerificationSentAt.getTime()) / (1000 * 60);
      if (minutesSinceLastSent < RESEND_THROTTLE_MINUTES) {
        const waitSeconds = Math.ceil((RESEND_THROTTLE_MINUTES - minutesSinceLastSent) * 60);
        return res.status(429).json({ 
          error: `Please wait ${waitSeconds} seconds before requesting another verification email` 
        });
      }
    }
    
    const rawToken = generateVerificationToken();
    const hashedToken = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);
    
    await prisma.user.update({
      where: { id: user.id },
      data: {
        verificationToken: hashedToken,
        verificationTokenExpiresAt: expiresAt,
        lastVerificationSentAt: new Date()
      }
    });
    
    const sent = await sendVerificationEmail(user.email, user.name, rawToken, APP_DOMAIN);
    
    if (!sent) {
      return res.status(500).json({ error: 'Failed to send verification email' });
    }
    
    res.json({ success: true, message: 'Verification email sent' });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Failed to resend verification' });
  }
});

router.get('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { 
        id: true, 
        name: true, 
        email: true,
        phone: true,
        phoneVerified: true,
        emailVerified: true,
        createdAt: true,
        subscriptionStatus: true,
        trialEndAt: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        stripePausedAt: true,
        isPro: true,
        paymentLinkEnabled: true,
        proBonusExpiresAt: true,
        demoStartedAt: true,
        demoPhase: true,
        bonusDemoDays: true,
        bonusTrialDays: true,
        role: true,
        parentUserId: true
      }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const hasActiveBonus = user.proBonusExpiresAt && user.proBonusExpiresAt > new Date();
    const hasStripeSubscription = !!user.stripeSubscriptionId;
    
    if (!hasActiveBonus && user.stripePausedAt && user.stripeSubscriptionId) {
      const resumeResult = await resumeStripeSubscription(req.userId!);
      if (resumeResult.success) {
        console.log(`[AUTO-RESUME] Stripe subscription resumed for user ${user.email} after Enterprise expired`);
      }
    }
    
    let effectiveStatus = user.subscriptionStatus;
    if (hasActiveBonus && user.subscriptionStatus === 'PENDING') {
      await prisma.user.update({
        where: { id: req.userId },
        data: { subscriptionStatus: 'ACTIVE' }
      });
      effectiveStatus = 'ACTIVE';
      console.log(`[AUTO-FIX] User ${user.email} had active bonus but PENDING status, corrected to ACTIVE`);
    }
    
    let planType: 'pro' | 'basic' | 'trial' | 'demo' | 'none' = 'none';
    if (hasActiveBonus || user.isPro) {
      planType = 'pro';
    } else if (hasStripeSubscription && (effectiveStatus === 'ACTIVE' || effectiveStatus === 'TRIAL')) {
      planType = 'basic';
    } else if (user.demoPhase === 'DEMO') {
      planType = 'demo';
    } else if (effectiveStatus === 'TRIAL') {
      planType = 'trial';
    }
    
    let demoInfo = null;
    if (user.demoPhase === 'DEMO' && user.demoStartedAt && !hasStripeSubscription) {
      const now = new Date();
      const demoStarted = new Date(user.demoStartedAt);
      const hoursSinceDemo = (now.getTime() - demoStarted.getTime()) / (1000 * 60 * 60);
      // Base demo is 48 hours (2 days) + bonus demo days from referral code
      const bonusDemoHours = (user.bonusDemoDays || 0) * 24;
      const totalDemoHours = 48 + bonusDemoHours;
      const hoursRemaining = Math.max(0, totalDemoHours - hoursSinceDemo);
      const demoExpired = hoursSinceDemo >= totalDemoHours;
      
      demoInfo = {
        demoStartedAt: user.demoStartedAt,
        hoursSinceDemo: Math.floor(hoursSinceDemo),
        hoursRemaining: Math.floor(hoursRemaining),
        daysRemaining: Math.ceil(hoursRemaining / 24),
        totalDemoDays: Math.ceil(totalDemoHours / 24),
        bonusDemoDays: user.bonusDemoDays || 0,
        demoExpired,
        needsCard: demoExpired
      };
    }
    
    res.json({
      ...user,
      subscriptionStatus: effectiveStatus.toLowerCase(),
      needsSubscription: effectiveStatus === 'PENDING' || effectiveStatus === 'CANCELED',
      isPro: user.isPro || hasActiveBonus,
      paymentLinkEnabled: user.paymentLinkEnabled || hasActiveBonus,
      proBonusExpiresAt: user.proBonusExpiresAt,
      hasActiveBonus,
      hasStripeSubscription,
      planType,
      demoPhase: user.demoPhase,
      demoInfo,
      role: user.role,
      parentUserId: user.parentUserId
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

router.get('/test-smtp', async (req: Request, res: Response) => {
  try {
    console.log('Testing SMTP connection...');
    console.log('SMTP Config:', {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      user: process.env.SMTP_USER ? `${process.env.SMTP_USER.substring(0, 5)}...` : 'NOT SET',
      pass: process.env.SMTP_PASS ? '****' : 'NOT SET',
      fromEmail: process.env.SMTP_FROM_EMAIL,
      fromName: process.env.SMTP_FROM_NAME
    });
    
    const success = await testSMTPConnection();
    
    if (success) {
      res.json({ 
        success: true, 
        message: 'SMTP connection successful',
        config: {
          host: process.env.SMTP_HOST,
          port: process.env.SMTP_PORT,
          user: process.env.SMTP_USER ? `${process.env.SMTP_USER.substring(0, 5)}...` : 'NOT SET'
        }
      });
    } else {
      res.status(500).json({ 
        success: false, 
        message: 'SMTP connection failed - check logs for details' 
      });
    }
  } catch (error: any) {
    console.error('SMTP test error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const user = await prisma.user.findUnique({ where: { email } });
    
    if (!user) {
      return res.json({ 
        success: true, 
        message: 'If an account with that email exists, you will receive a password reset link' 
      });
    }
    
    if (user.lastPasswordResetSentAt) {
      const minutesSinceLastSent = (Date.now() - user.lastPasswordResetSentAt.getTime()) / (1000 * 60);
      if (minutesSinceLastSent < RESEND_THROTTLE_MINUTES) {
        const waitSeconds = Math.ceil((RESEND_THROTTLE_MINUTES - minutesSinceLastSent) * 60);
        return res.status(429).json({ 
          error: `Please wait ${waitSeconds} seconds before requesting another password reset` 
        });
      }
    }
    
    const rawToken = generateVerificationToken();
    const hashedToken = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_HOURS * 60 * 60 * 1000);
    
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: hashedToken,
        passwordResetExpiresAt: expiresAt,
        lastPasswordResetSentAt: new Date()
      }
    });
    
    const sent = await sendPasswordResetEmail(user.email, user.name, rawToken, APP_DOMAIN);
    
    if (!sent) {
      console.error(`Failed to send password reset email to ${email}`);
    }
    
    res.json({ 
      success: true, 
      message: 'If an account with that email exists, you will receive a password reset link' 
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body;
    
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }
    
    const hashedToken = hashToken(token);
    
    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: hashedToken,
        passwordResetExpiresAt: { gte: new Date() }
      }
    });
    
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetToken: null,
        passwordResetExpiresAt: null
      }
    });
    
    console.log(`Password reset successful for user ${user.id}`);
    
    res.json({ success: true, message: 'Password has been reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

router.get('/verify-reset-token', async (req: Request, res: Response) => {
  try {
    const { token } = req.query;
    
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ valid: false, error: 'Invalid token' });
    }
    
    const hashedToken = hashToken(token);
    
    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: hashedToken,
        passwordResetExpiresAt: { gte: new Date() }
      }
    });
    
    if (!user) {
      return res.status(400).json({ valid: false, error: 'Invalid or expired reset token' });
    }
    
    res.json({ valid: true, email: user.email });
  } catch (error) {
    console.error('Verify reset token error:', error);
    res.status(500).json({ valid: false, error: 'Failed to verify token' });
  }
});

router.post('/apply-referral', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Referral code is required' });
    }
    
    const user = await prisma.user.findUnique({
      where: { id: req.userId }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const refCode = await prisma.referralCode.findFirst({
      where: { 
        code: code.toUpperCase(),
        isActive: true,
        type: 'ENTERPRISE'
      }
    });
    
    if (!refCode) {
      return res.status(400).json({ error: 'Invalid or inactive referral code' });
    }
    
    if (refCode.expiresAt && refCode.expiresAt < new Date()) {
      return res.status(400).json({ error: 'This referral code has expired' });
    }
    
    if (refCode.maxUses && refCode.usageCount >= refCode.maxUses) {
      return res.status(400).json({ error: 'This referral code has reached its maximum uses' });
    }
    
    const grantDays = refCode.grantDurationDays || 7;
    
    // Accumulate days: if user already has active Enterprise, add days to existing expiration
    // Otherwise, start from now
    let proBonusExpiresAt: Date;
    const now = new Date();
    const hasActiveBonus = user.proBonusExpiresAt && user.proBonusExpiresAt > now;
    
    if (hasActiveBonus) {
      // Add days to existing expiration date
      proBonusExpiresAt = new Date(user.proBonusExpiresAt!);
      proBonusExpiresAt.setDate(proBonusExpiresAt.getDate() + grantDays);
      console.log(`[ENTERPRISE] Accumulating ${grantDays} days to existing bonus for user ${user.id}`);
    } else {
      // Start fresh from now
      proBonusExpiresAt = new Date();
      proBonusExpiresAt.setDate(proBonusExpiresAt.getDate() + grantDays);
    }
    
    if (user.stripeSubscriptionId) {
      const pauseResult = await pauseStripeSubscription(user.id);
      if (pauseResult.success) {
        console.log(`[ENTERPRISE] Paused Stripe subscription for user ${user.id} while Enterprise is active`);
      } else {
        console.log(`[ENTERPRISE] Could not pause Stripe subscription: ${pauseResult.error}`);
      }
    }
    
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          proBonusExpiresAt,
          isPro: true,
          paymentLinkEnabled: true,
          subscriptionStatus: 'ACTIVE'
        }
      }),
      prisma.referralCode.update({
        where: { id: refCode.id },
        data: { usageCount: { increment: 1 } }
      })
    ]);
    
    const actionType = hasActiveBonus ? 'accumulated' : 'activated';
    console.log(`[ENTERPRISE] User ${user.id} ${actionType} referral code ${refCode.code}, +${grantDays} days, Pro bonus expires at ${proBonusExpiresAt}`);
    
    const message = hasActiveBonus 
      ? `Se agregaron ${grantDays} días a tu plan Enterprise`
      : `Plan Enterprise activado por ${grantDays} días`;
    
    res.json({ 
      success: true, 
      message,
      proBonusExpiresAt,
      daysAdded: grantDays,
      accumulated: hasActiveBonus
    });
  } catch (error) {
    console.error('Apply referral error:', error);
    res.status(500).json({ error: 'Failed to apply referral code' });
  }
});

router.get('/advisor-invitation/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    
    const invitation = await prisma.advisorInvitation.findUnique({
      where: { token },
      include: { 
        business: { select: { name: true } },
        invitedBy: { select: { name: true } }
      }
    });
    
    if (!invitation) {
      return res.status(404).json({ error: 'Invalid invitation token' });
    }
    
    if (invitation.acceptedAt) {
      return res.status(400).json({ error: 'This invitation has already been used' });
    }
    
    if (invitation.expiresAt < new Date()) {
      return res.status(400).json({ error: 'This invitation has expired' });
    }
    
    res.json({
      email: invitation.email,
      businessName: invitation.business.name,
      invitedByName: invitation.invitedBy.name
    });
  } catch (error) {
    console.error('Get advisor invitation error:', error);
    res.status(500).json({ error: 'Failed to get invitation' });
  }
});

router.post('/advisor-signup', async (req: Request, res: Response) => {
  try {
    const { token, name, password } = req.body;
    
    if (!token || !name || !password) {
      return res.status(400).json({ error: 'Token, name and password are required' });
    }
    
    const invitation = await prisma.advisorInvitation.findUnique({
      where: { token },
      include: { business: true }
    });
    
    if (!invitation) {
      return res.status(404).json({ error: 'Invalid invitation token' });
    }
    
    if (invitation.acceptedAt) {
      return res.status(400).json({ error: 'This invitation has already been used' });
    }
    
    if (invitation.expiresAt < new Date()) {
      return res.status(400).json({ error: 'This invitation has expired' });
    }
    
    const existingUser = await prisma.user.findUnique({ 
      where: { email: invitation.email } 
    });
    
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email: invitation.email,
          passwordHash,
          role: 'ASESOR',
          parentUserId: invitation.invitedById,
          emailVerified: true,
          subscriptionStatus: 'ACTIVE'
        }
      });
      
      await tx.advisorInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() }
      });
      
      return user;
    });
    
    const authToken = generateToken(result.id);
    
    res.status(201).json({
      user: {
        id: result.id,
        name: result.name,
        email: result.email,
        role: result.role,
        parentUserId: result.parentUserId
      },
      token: authToken,
      message: 'Account created successfully'
    });
  } catch (error) {
    console.error('Advisor signup error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// ============================================
// USER REFERRAL PROGRAM ENDPOINTS
// ============================================

// Get user's referral code (if they have one)
router.get('/referral/my-code', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const referralCode = await prisma.referralCode.findFirst({
      where: { ownerUserId: req.userId }
    });
    
    if (!referralCode) {
      return res.json({ hasCode: false, code: null });
    }
    
    res.json({
      hasCode: true,
      code: referralCode.code,
      description: referralCode.description,
      usageCount: referralCode.usageCount,
      bonusDemoDays: referralCode.bonusDemoDays || 0,
      bonusTrialDays: referralCode.bonusTrialDays || 0,
      commissionRate: referralCode.commissionRate,
      createdAt: referralCode.createdAt
    });
  } catch (error) {
    console.error('Get my referral code error:', error);
    res.status(500).json({ error: 'Failed to get referral code' });
  }
});

// Claim/create a referral code for the user
router.post('/referral/claim', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({ error: 'Code is required' });
    }
    
    // Check if user already has a code
    const existingUserCode = await prisma.referralCode.findFirst({
      where: { ownerUserId: req.userId }
    });
    
    if (existingUserCode) {
      return res.status(400).json({ 
        error: 'Ya tienes un código de referido activo',
        existingCode: existingUserCode.code
      });
    }
    
    // Validate code format (uppercase, alphanumeric, 4-20 chars)
    const normalizedCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalizedCode.length < 4 || normalizedCode.length > 20) {
      return res.status(400).json({ error: 'El código debe tener entre 4 y 20 caracteres alfanuméricos' });
    }
    
    // Check if code already exists
    const existingCode = await prisma.referralCode.findUnique({
      where: { code: normalizedCode }
    });
    
    if (existingCode) {
      return res.status(400).json({ 
        error: 'Este código ya está en uso. Por favor, elige otro.' 
      });
    }
    
    // Create the referral code for the user
    const referralCode = await prisma.referralCode.create({
      data: {
        code: normalizedCode,
        description: `Código de afiliado`,
        type: 'STANDARD',
        ownerUserId: req.userId,
        isActive: true,
        commissionRate: 0.10, // 10% default commission
        bonusDemoDays: 0,
        bonusTrialDays: 0
      }
    });
    
    console.log(`[REFERRAL] User ${req.userId} claimed code: ${normalizedCode}`);
    
    res.json({
      success: true,
      code: referralCode.code,
      message: 'Código creado exitosamente'
    });
  } catch (error) {
    console.error('Claim referral code error:', error);
    res.status(500).json({ error: 'Failed to claim referral code' });
  }
});

// Get referral stats for the user
router.get('/referral/stats', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    // Get user's referral code
    const referralCode = await prisma.referralCode.findFirst({
      where: { ownerUserId: req.userId }
    });
    
    if (!referralCode) {
      return res.json({
        hasCode: false,
        stats: null
      });
    }
    
    // Get all users who registered with this code
    const referredUsers = await prisma.user.findMany({
      where: { referralCodeId: referralCode.id },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        subscriptionStatus: true,
        stripeSubscriptionId: true
      },
      orderBy: { createdAt: 'desc' }
    });
    
    // Calculate stats
    const totalReferrals = referredUsers.length;
    const activeSubscriptions = referredUsers.filter(u => 
      u.subscriptionStatus === 'ACTIVE' && u.stripeSubscriptionId
    ).length;
    const trialUsers = referredUsers.filter(u => 
      u.subscriptionStatus === 'TRIAL'
    ).length;
    
    // Calculate estimated earnings (this is simplified - in production you'd track actual payments)
    // Assuming $97/month subscription and 20% commission
    const monthlySubscriptionPrice = 97;
    const estimatedMonthlyEarnings = activeSubscriptions * monthlySubscriptionPrice * referralCode.commissionRate;
    
    res.json({
      hasCode: true,
      code: referralCode.code,
      stats: {
        totalReferrals,
        activeSubscriptions,
        trialUsers,
        conversionRate: totalReferrals > 0 ? Math.round((activeSubscriptions / totalReferrals) * 100) : 0,
        commissionRate: referralCode.commissionRate * 100,
        estimatedMonthlyEarnings,
        referredUsers: referredUsers.map(u => ({
          id: u.id,
          name: u.name,
          email: u.email.substring(0, 3) + '***' + u.email.substring(u.email.indexOf('@')), // Mask email
          registeredAt: u.createdAt,
          status: u.subscriptionStatus,
          isConverted: u.subscriptionStatus === 'ACTIVE' && !!u.stripeSubscriptionId
        }))
      }
    });
  } catch (error) {
    console.error('Get referral stats error:', error);
    res.status(500).json({ error: 'Failed to get referral stats' });
  }
});

// Store Google OAuth states temporarily (in production, use Redis)
const googleAuthStates = new Map<string, { referralCode?: string; createdAt: number }>();

// Clean up old states periodically
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of googleAuthStates.entries()) {
    if (now - data.createdAt > 10 * 60 * 1000) { // 10 minutes
      googleAuthStates.delete(state);
    }
  }
}, 60000);

router.put('/profile', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { name, businessName, phone } = req.body;
    
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { businesses: true }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userUpdates: any = {};
    let phoneChanged = false;
    
    if (name && name.trim()) {
      userUpdates.name = name.trim();
    }
    
    if (phone !== undefined) {
      const cleanPhone = phone ? phone.replace(/[^\d+]/g, '').replace(/\s+/g, '') : null;
      const normalizedPhone = cleanPhone && !cleanPhone.startsWith('+') ? cleanPhone : cleanPhone;
      if (normalizedPhone !== user.phone) {
        userUpdates.phone = normalizedPhone;
        userUpdates.phoneVerified = false;
        userUpdates.phoneVerificationCode = null;
        userUpdates.phoneVerificationExpiresAt = null;
        phoneChanged = true;
      }
    }
    
    if (Object.keys(userUpdates).length > 0) {
      await prisma.user.update({
        where: { id: req.userId },
        data: userUpdates
      });
    }
    
    if (businessName && user.businesses.length > 0) {
      await prisma.business.update({
        where: { id: user.businesses[0].id },
        data: { name: businessName }
      });
    }
    
    res.json({ success: true, phoneChanged });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

const PHONE_VERIFICATION_EXPIRY_MINUTES = 10;
const PHONE_RESEND_THROTTLE_MINUTES = 1;

async function sendPhoneVerificationCode(userId: string, phone: string): Promise<{ success: boolean; error?: string }> {
  try {
    const delegation = await prisma.agentDelegation.findFirst({
      where: { isActive: true },
      include: {
        agentUser: {
          include: {
            businesses: {
              include: {
                instances: {
                  include: { metaCredential: true }
                }
              }
            }
          }
        }
      }
    });
    
    if (!delegation) {
      return { success: false, error: 'No hay un agente delegado configurado para enviar verificaciones' };
    }
    
    const agentBusiness = delegation.agentUser.businesses[0];
    if (!agentBusiness) {
      return { success: false, error: 'El agente delegado no tiene un negocio configurado' };
    }
    
    const connectedInstance = agentBusiness.instances.find(inst => {
      if (inst.provider === 'META_CLOUD') {
        return inst.metaCredential && 
               inst.metaCredential.accessToken && 
               inst.metaCredential.phoneNumberId;
      } else {
        return inst.status === 'open';
      }
    });
    
    if (!connectedInstance) {
      return { success: false, error: 'El agente delegado no tiene una instancia de WhatsApp conectada' };
    }
    
    const instance = connectedInstance;
    
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + PHONE_VERIFICATION_EXPIRY_MINUTES * 60 * 1000);
    
    await prisma.user.update({
      where: { id: userId },
      data: {
        phoneVerificationCode: code,
        phoneVerificationExpiresAt: expiresAt,
        lastPhoneVerificationSentAt: new Date()
      }
    });
    
    const message = `Tu codigo de verificacion es: *${code}*\n\nEste codigo expira en ${PHONE_VERIFICATION_EXPIRY_MINUTES} minutos.\n\nSi no solicitaste este codigo, ignora este mensaje.`;
    
    const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';
    
    if (instance.provider === 'META_CLOUD' && instance.metaCredential) {
      const { MetaCloudService } = await import('../services/metaCloud.js');
      const metaService = new MetaCloudService({
        accessToken: instance.metaCredential.accessToken,
        phoneNumberId: instance.metaCredential.phoneNumberId,
        businessId: instance.metaCredential.businessId
      });
      await metaService.sendTextMessage(phone, message);
    } else {
      const axios = (await import('axios')).default;
      await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/sendMessage`, {
        phone,
        message
      });
    }
    
    console.log(`[PhoneVerification] Code sent to ${phone} for user ${userId}`);
    return { success: true };
  } catch (error: any) {
    console.error('[PhoneVerification] Error sending code:', error);
    return { success: false, error: error.message || 'Error al enviar el codigo' };
  }
}

router.post('/phone/send-verification', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { phone } = req.body;
    
    if (!phone) {
      return res.status(400).json({ error: 'El numero de telefono es requerido' });
    }
    
    const normalizedPhone = phone.replace(/\s+/g, '');
    if (!normalizedPhone.startsWith('+') || normalizedPhone.length < 10) {
      return res.status(400).json({ error: 'Formato de telefono invalido. Debe incluir codigo de pais (ej: +51999888777)' });
    }
    
    const user = await prisma.user.findUnique({
      where: { id: req.userId }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    if (user.phone === normalizedPhone && user.phoneVerified) {
      return res.status(400).json({ error: 'Este numero ya esta verificado' });
    }
    
    if (user.lastPhoneVerificationSentAt) {
      const timeSinceLastSend = Date.now() - user.lastPhoneVerificationSentAt.getTime();
      const throttleMs = PHONE_RESEND_THROTTLE_MINUTES * 60 * 1000;
      if (timeSinceLastSend < throttleMs) {
        const waitSeconds = Math.ceil((throttleMs - timeSinceLastSend) / 1000);
        return res.status(429).json({ 
          error: `Espera ${waitSeconds} segundos antes de solicitar otro codigo`,
          waitSeconds
        });
      }
    }
    
    await prisma.user.update({
      where: { id: req.userId },
      data: { pendingPhone: normalizedPhone }
    });
    
    const result = await sendPhoneVerificationCode(req.userId!, normalizedPhone);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }
    
    res.json({ 
      success: true, 
      message: 'Codigo de verificacion enviado',
      expiresInMinutes: PHONE_VERIFICATION_EXPIRY_MINUTES
    });
  } catch (error) {
    console.error('Send phone verification error:', error);
    res.status(500).json({ error: 'Error al enviar el codigo de verificacion' });
  }
});

router.post('/phone/verify', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({ error: 'El codigo es requerido' });
    }
    
    const user = await prisma.user.findUnique({
      where: { id: req.userId }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    if (!user.pendingPhone) {
      return res.status(400).json({ error: 'No hay un numero pendiente de verificacion. Solicita un codigo primero.' });
    }
    
    if (!user.phoneVerificationCode || !user.phoneVerificationExpiresAt) {
      return res.status(400).json({ error: 'No hay un codigo de verificacion pendiente. Solicita uno nuevo.' });
    }
    
    if (new Date() > user.phoneVerificationExpiresAt) {
      return res.status(400).json({ error: 'El codigo ha expirado. Solicita uno nuevo.' });
    }
    
    if (code !== user.phoneVerificationCode) {
      return res.status(400).json({ error: 'Codigo incorrecto' });
    }
    
    await prisma.user.update({
      where: { id: req.userId },
      data: {
        phone: user.pendingPhone,
        pendingPhone: null,
        phoneVerified: true,
        phoneVerificationCode: null,
        phoneVerificationExpiresAt: null
      }
    });
    
    console.log(`[PhoneVerification] Phone ${user.pendingPhone} verified and saved for user ${req.userId}`);
    
    res.json({ success: true, message: 'Numero verificado correctamente' });
  } catch (error) {
    console.error('Verify phone error:', error);
    res.status(500).json({ error: 'Error al verificar el codigo' });
  }
});

router.get('/google/status', async (req: Request, res: Response) => {
  res.json({ configured: isGoogleAuthConfigured() });
});

router.get('/google', async (req: Request, res: Response) => {
  const getFrontendUrl = () => process.env.FRONTEND_URL || process.env.APP_DOMAIN || 
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : 'http://localhost:5000');
  
  try {
    if (!isGoogleAuthConfigured()) {
      return res.status(503).json({ error: 'Google authentication is not configured' });
    }
    
    const { referralCode } = req.query;
    const state = uuidv4();
    
    googleAuthStates.set(state, {
      referralCode: typeof referralCode === 'string' ? referralCode : undefined,
      createdAt: Date.now()
    });
    
    const authUrl = getGoogleAuthUrl(state);
    console.log(`[GoogleAuth] Redirecting to Google: ${authUrl}`);
    res.redirect(authUrl);
  } catch (error) {
    console.error('[GoogleAuth] Start error:', error);
    const frontendUrl = getFrontendUrl();
    res.redirect(`${frontendUrl}/login?error=google_auth_failed`);
  }
});

router.get('/google/callback', async (req: Request, res: Response) => {
  const getFrontendUrl = () => process.env.FRONTEND_URL || process.env.APP_DOMAIN || 
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : 'http://localhost:5000');
  
  try {
    const { code, state } = req.query;
    const frontendUrl = getFrontendUrl();
    
    if (!code || typeof code !== 'string') {
      return res.redirect(`${frontendUrl}/login?error=no_code`);
    }
    
    if (!state || typeof state !== 'string') {
      return res.redirect(`${frontendUrl}/login?error=invalid_state`);
    }
    
    const stateData = googleAuthStates.get(state);
    if (!stateData) {
      return res.redirect(`${frontendUrl}/login?error=expired_state`);
    }
    googleAuthStates.delete(state);
    
    const googleUser = await getGoogleUserInfo(code);
    console.log(`[GoogleAuth] Got user info: ${googleUser.email}`);
    
    // Check if user exists by googleId or email
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { googleId: googleUser.id },
          { email: googleUser.email }
        ]
      }
    });
    
    let isNewUser = false;
    
    if (user) {
      // Existing user - update Google info if not already linked
      if (!user.googleId) {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            googleId: googleUser.id,
            googlePicture: googleUser.picture,
            emailVerified: true // Google emails are verified
          }
        });
        console.log(`[GoogleAuth] Linked Google account to existing user: ${user.email}`);
      }
    } else {
      // New user - create account
      isNewUser = true;
      
      // Process referral code if provided
      let validReferralCode: string | null = null;
      let enterpriseCode: any = null;
      let standardCode: any = null;
      
      if (stateData.referralCode) {
        const refCode = await prisma.referralCode.findUnique({
          where: { code: stateData.referralCode.toUpperCase() }
        });
        
        if (refCode && refCode.isActive) {
          if (!refCode.expiresAt || refCode.expiresAt > new Date()) {
            if (!refCode.maxUses || refCode.usageCount < refCode.maxUses) {
              validReferralCode = refCode.code;
              
              await prisma.referralCode.update({
                where: { id: refCode.id },
                data: { usageCount: { increment: 1 } }
              });
              
              if (refCode.type === 'ENTERPRISE' && refCode.grantDurationDays) {
                enterpriseCode = refCode;
              } else {
                standardCode = refCode;
              }
            }
          }
        }
      }
      
      const result = await prisma.$transaction(async (tx) => {
        const isPro = !!enterpriseCode;
        const subscriptionStatus = enterpriseCode ? 'ACTIVE' : 'TRIAL';
        const referralCodeRecord = enterpriseCode || standardCode;
        const bonusDemoDays = standardCode?.bonusDemoDays || 0;
        const bonusTrialDays = standardCode?.bonusTrialDays || 0;
        
        const baseDemoDays = 2;
        const totalDemoDays = baseDemoDays + bonusDemoDays;
        const trialEndAt = enterpriseCode ? null : new Date(Date.now() + totalDemoDays * 24 * 60 * 60 * 1000);
        
        const newUser = await tx.user.create({
          data: {
            name: googleUser.name,
            email: googleUser.email,
            googleId: googleUser.id,
            googlePicture: googleUser.picture,
            emailVerified: true, // Google accounts are pre-verified
            referralCode: validReferralCode,
            referralCodeId: referralCodeRecord?.id || null,
            bonusDemoDays,
            bonusTrialDays,
            isPro,
            subscriptionStatus,
            subscriptionTier: 'BASIC',
            trialEndAt,
            demoStartedAt: enterpriseCode ? null : new Date(),
            demoPhase: enterpriseCode ? 'ACTIVE' : 'DEMO'
          }
        });
        
        if (enterpriseCode) {
          const now = new Date();
          const subscriptionEndsAt = new Date(now.getTime() + enterpriseCode.grantDurationDays * 24 * 60 * 60 * 1000);
          
          await tx.subscription.create({
            data: {
              userId: newUser.id,
              source: 'ENTERPRISE',
              tier: enterpriseCode.grantTier || 'PRO',
              status: 'ACTIVE',
              startsAt: now,
              endsAt: subscriptionEndsAt,
              referralCodeId: enterpriseCode.id,
              activatedBy: 'referral_code',
              notes: `Auto-activated via enterprise code: ${enterpriseCode.code} (Google Sign-In)`
            }
          });
        }
        
        // Create default business with generic name (will ask for details later)
        const business = await tx.business.create({
          data: {
            userId: newUser.id,
            name: 'Mi Empresa',
            description: 'Configura los datos de tu empresa',
            botEnabled: true
          }
        });
        
        console.log(`[GoogleAuth] Created new user ${newUser.id} and business ${business.id}`);
        
        return { user: newUser, business, isPro };
      });
      
      user = result.user;
    }
    
    const token = generateToken(user.id);
    
    // Redirect to frontend with token
    const redirectUrl = isNewUser 
      ? `${frontendUrl}/auth/google/callback?token=${token}&new=true`
      : `${frontendUrl}/auth/google/callback?token=${token}`;
    
    console.log(`[GoogleAuth] Redirecting to: ${redirectUrl}`);
    res.redirect(redirectUrl);
  } catch (error: any) {
    console.error('[GoogleAuth] Callback error:', error);
    const frontendUrl = getFrontendUrl();
    res.redirect(`${frontendUrl}/login?error=google_auth_failed`);
  }
});

router.post('/google/exchange', async (req: Request, res: Response) => {
  try {
    const { code, state } = req.body;
    
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Authorization code is required' });
    }
    
    if (!state || typeof state !== 'string') {
      return res.status(400).json({ error: 'State parameter is required' });
    }
    
    const stateData = googleAuthStates.get(state);
    if (!stateData) {
      return res.status(400).json({ error: 'Invalid or expired state' });
    }
    googleAuthStates.delete(state);
    
    const googleUser = await getGoogleUserInfo(code);
    console.log(`[GoogleAuth Exchange] Got user info: ${googleUser.email}`);
    
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { googleId: googleUser.id },
          { email: googleUser.email }
        ]
      }
    });
    
    let isNewUser = false;
    
    if (user) {
      if (!user.googleId) {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            googleId: googleUser.id,
            googlePicture: googleUser.picture,
            emailVerified: true
          }
        });
        console.log(`[GoogleAuth Exchange] Linked Google account to existing user: ${user.email}`);
      }
    } else {
      isNewUser = true;
      
      let validReferralCode: string | null = null;
      let enterpriseCode: any = null;
      let standardCode: any = null;
      
      if (stateData.referralCode) {
        const refCode = await prisma.referralCode.findUnique({
          where: { code: stateData.referralCode.toUpperCase() }
        });
        
        if (refCode && refCode.isActive) {
          if (!refCode.expiresAt || refCode.expiresAt > new Date()) {
            if (!refCode.maxUses || refCode.usageCount < refCode.maxUses) {
              validReferralCode = refCode.code;
              
              await prisma.referralCode.update({
                where: { id: refCode.id },
                data: { usageCount: { increment: 1 } }
              });
              
              if (refCode.type === 'ENTERPRISE' && refCode.grantDurationDays) {
                enterpriseCode = refCode;
              } else {
                standardCode = refCode;
              }
            }
          }
        }
      }
      
      const result = await prisma.$transaction(async (tx) => {
        const isPro = !!enterpriseCode;
        const subscriptionStatus = enterpriseCode ? 'ACTIVE' : 'TRIAL';
        const referralCodeRecord = enterpriseCode || standardCode;
        const bonusDemoDays = standardCode?.bonusDemoDays || 0;
        const bonusTrialDays = standardCode?.bonusTrialDays || 0;
        
        const baseDemoDays = 2;
        const totalDemoDays = baseDemoDays + bonusDemoDays;
        const trialEndAt = enterpriseCode ? null : new Date(Date.now() + totalDemoDays * 24 * 60 * 60 * 1000);
        
        const newUser = await tx.user.create({
          data: {
            name: googleUser.name,
            email: googleUser.email,
            googleId: googleUser.id,
            googlePicture: googleUser.picture,
            emailVerified: true,
            referralCode: validReferralCode,
            referralCodeId: referralCodeRecord?.id || null,
            bonusDemoDays,
            bonusTrialDays,
            isPro,
            subscriptionStatus,
            subscriptionTier: 'BASIC',
            trialEndAt,
            demoStartedAt: enterpriseCode ? null : new Date(),
            demoPhase: enterpriseCode ? 'ACTIVE' : 'DEMO'
          }
        });
        
        if (enterpriseCode) {
          const now = new Date();
          const subscriptionEndsAt = new Date(now.getTime() + enterpriseCode.grantDurationDays * 24 * 60 * 60 * 1000);
          
          await tx.subscription.create({
            data: {
              userId: newUser.id,
              source: 'ENTERPRISE',
              tier: 'ENTERPRISE',
              status: 'ACTIVE',
              startsAt: now,
              endsAt: subscriptionEndsAt,
              referralCodeId: enterpriseCode.id
            }
          });
        }
        
        const business = await tx.business.create({
          data: {
            userId: newUser.id,
            name: 'Mi Empresa',
            description: 'Configura los datos de tu empresa',
            botEnabled: true
          }
        });
        
        console.log(`[GoogleAuth Exchange] Created new user ${newUser.id} and business ${business.id}`);
        
        return { user: newUser, business, isPro };
      });
      
      user = result.user;
    }
    
    const token = generateToken(user.id);
    
    console.log(`[GoogleAuth Exchange] Success for user: ${user.email}, isNew: ${isNewUser}`);
    res.json({ token, isNew: isNewUser });
  } catch (error: any) {
    console.error('[GoogleAuth Exchange] Error:', error);
    res.status(500).json({ error: 'Failed to exchange authorization code' });
  }
});

export default router;

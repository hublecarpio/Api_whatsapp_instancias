import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../services/prisma.js';
import { authMiddleware, generateToken, AuthRequest } from '../middleware/auth.js';
import { generateVerificationToken, hashToken, sendVerificationEmail, sendPasswordResetEmail, testSMTPConnection } from '../services/emailService.js';

const router = Router();

const APP_DOMAIN = process.env.APP_DOMAIN || process.env.FRONTEND_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;
const VERIFICATION_TOKEN_EXPIRY_HOURS = 24;
const PASSWORD_RESET_EXPIRY_HOURS = 1;
const RESEND_THROTTLE_MINUTES = 2;

router.post('/register', async (req: Request, res: Response) => {
  try {
    const { name, email, password, referralCode } = req.body;
    
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    
    let validReferralCode: string | null = null;
    let enterpriseCode: any = null;
    
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
              console.log(`[REFERRAL] Valid code used: ${refCode.code}, new count: ${refCode.usageCount + 1}`);
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
      const subscriptionStatus = enterpriseCode ? 'ACTIVE' : 'PENDING';
      
      const user = await tx.user.create({
        data: { 
          name, 
          email, 
          passwordHash,
          emailVerified: false,
          verificationToken: hashedToken,
          verificationTokenExpiresAt: expiresAt,
          lastVerificationSentAt: new Date(),
          referralCode: validReferralCode,
          isPro,
          subscriptionStatus
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
          name: 'Mi Empresa',
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
      grantDurationDays: refCode.grantDurationDays
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
    if (!user) {
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
        paymentLinkEnabled: user.paymentLinkEnabled
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
        emailVerified: true,
        createdAt: true,
        subscriptionStatus: true,
        trialEndAt: true,
        stripeCustomerId: true,
        isPro: true,
        paymentLinkEnabled: true
      }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
      ...user,
      subscriptionStatus: user.subscriptionStatus.toLowerCase(),
      needsSubscription: user.subscriptionStatus === 'PENDING' || user.subscriptionStatus === 'CANCELED',
      isPro: user.isPro,
      paymentLinkEnabled: user.paymentLinkEnabled
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

export default router;

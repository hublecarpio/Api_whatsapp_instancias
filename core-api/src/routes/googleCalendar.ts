import { Router, Request, Response } from 'express';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { GoogleCalendarService } from '../services/googleCalendar.js';

const router = Router();

router.get('/status', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    
    const business = await prisma.business.findFirst({
      where: { userId },
      include: { googleCalendar: true }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const isConfigured = GoogleCalendarService.isConfigured();
    const isConnected = !!business.googleCalendar;

    res.json({
      configured: isConfigured,
      connected: isConnected,
      email: business.googleCalendar?.connectedEmail || null,
      calendarId: business.googleCalendar?.calendarId || null,
      syncEnabled: business.googleCalendar?.syncEnabled || false
    });
  } catch (error: any) {
    console.error('[GoogleCalendar] Status error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/auth-url', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    
    if (!GoogleCalendarService.isConfigured()) {
      return res.status(400).json({ error: 'Google Calendar integration not configured' });
    }

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const state = Buffer.from(JSON.stringify({ businessId: business.id, userId })).toString('base64');
    const authUrl = GoogleCalendarService.getAuthUrl(state);

    res.json({ authUrl });
  } catch (error: any) {
    console.error('[GoogleCalendar] Auth URL error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      console.error('[GoogleCalendar] OAuth error:', oauthError);
      return res.redirect('/dashboard/settings?gcal_error=oauth_denied');
    }

    if (!code || !state) {
      return res.redirect('/dashboard/settings?gcal_error=missing_params');
    }

    let stateData: { businessId: string; userId: string };
    try {
      stateData = JSON.parse(Buffer.from(state as string, 'base64').toString());
    } catch {
      return res.redirect('/dashboard/settings?gcal_error=invalid_state');
    }

    const tokens = await GoogleCalendarService.exchangeCodeForTokens(code as string);
    const email = await GoogleCalendarService.getUserEmail(tokens.access_token);

    await prisma.googleCalendarCredential.upsert({
      where: { businessId: stateData.businessId },
      create: {
        businessId: stateData.businessId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token!,
        tokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
        connectedEmail: email
      },
      update: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || undefined,
        tokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
        connectedEmail: email
      }
    });

    console.log(`[GoogleCalendar] Connected for business ${stateData.businessId}, email: ${email}`);
    res.redirect('/dashboard/appointments?gcal_success=true');
  } catch (error: any) {
    console.error('[GoogleCalendar] Callback error:', error);
    res.redirect('/dashboard/appointments?gcal_error=token_exchange_failed');
  }
});

router.post('/disconnect', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    
    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    await prisma.googleCalendarCredential.deleteMany({
      where: { businessId: business.id }
    });

    console.log(`[GoogleCalendar] Disconnected for business ${business.id}`);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[GoogleCalendar] Disconnect error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/settings', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { calendarId, syncEnabled } = req.body;
    
    const business = await prisma.business.findFirst({
      where: { userId },
      include: { googleCalendar: true }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    if (!business.googleCalendar) {
      return res.status(400).json({ error: 'Google Calendar not connected' });
    }

    const updated = await prisma.googleCalendarCredential.update({
      where: { businessId: business.id },
      data: {
        ...(calendarId !== undefined && { calendarId }),
        ...(syncEnabled !== undefined && { syncEnabled })
      }
    });

    res.json({
      calendarId: updated.calendarId,
      syncEnabled: updated.syncEnabled
    });
  } catch (error: any) {
    console.error('[GoogleCalendar] Settings update error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

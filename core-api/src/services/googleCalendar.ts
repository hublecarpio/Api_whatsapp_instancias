import prisma from './prisma.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// For OAuth callbacks, we need the PUBLIC URL (accessible from browser)
// GOOGLE_CALLBACK_URL = public API URL for OAuth redirects
// Falls back to BACKEND_URL, APP_DOMAIN, or REPLIT_DEV_DOMAIN
function getPublicApiUrl(): string {
  // Priority: GOOGLE_CALLBACK_URL > BACKEND_URL > APP_DOMAIN > REPLIT_DEV_DOMAIN
  if (process.env.GOOGLE_CALLBACK_URL) {
    return process.env.GOOGLE_CALLBACK_URL;
  }
  if (process.env.BACKEND_URL) {
    return process.env.BACKEND_URL;
  }
  if (process.env.APP_DOMAIN) {
    return process.env.APP_DOMAIN;
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  return 'http://localhost:3001';
}

function getCalendarRedirectUri(): string {
  // Specific override takes priority
  if (process.env.GOOGLE_REDIRECT_URI) {
    return process.env.GOOGLE_REDIRECT_URI;
  }
  const publicUrl = getPublicApiUrl();
  const uri = `${publicUrl}/google-calendar/callback`;
  console.log('[GoogleCalendar] Redirect URI:', uri);
  return uri;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

interface CalendarEvent {
  id?: string;
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees?: Array<{ email: string; displayName?: string }>;
  conferenceData?: {
    createRequest?: {
      requestId: string;
      conferenceSolutionKey: { type: string };
    };
  };
  hangoutLink?: string;
}

interface FreeBusyResponse {
  calendars: {
    [calendarId: string]: {
      busy: Array<{ start: string; end: string }>;
    };
  };
}

export class GoogleCalendarService {
  private accessToken: string;
  private refreshToken: string;
  private tokenExpiry: Date;
  private businessId: string;

  constructor(businessId: string, accessToken: string, refreshToken: string, tokenExpiry: Date) {
    this.businessId = businessId;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.tokenExpiry = tokenExpiry;
  }

  static isConfigured(): boolean {
    return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
  }

  static getAuthUrl(state: string): string {
    if (!GOOGLE_CLIENT_ID) {
      throw new Error('Google Client ID not configured');
    }

    const scopes = [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email'
    ];

    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: getCalendarRedirectUri(),
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  static async exchangeCodeForTokens(code: string): Promise<TokenResponse> {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      throw new Error('Google OAuth not configured');
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: getCalendarRedirectUri(),
        grant_type: 'authorization_code'
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    return response.json();
  }

  static async getUserEmail(accessToken: string): Promise<string> {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      throw new Error('Failed to get user info');
    }

    const data = await response.json();
    return data.email;
  }

  private async ensureValidToken(): Promise<string> {
    if (new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      throw new Error('Google OAuth not configured');
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: this.refreshToken,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token'
      })
    });

    if (!response.ok) {
      throw new Error('Failed to refresh token');
    }

    const tokens: TokenResponse = await response.json();
    this.accessToken = tokens.access_token;
    this.tokenExpiry = new Date(Date.now() + tokens.expires_in * 1000);

    await prisma.googleCalendarCredential.update({
      where: { businessId: this.businessId },
      data: {
        accessToken: this.accessToken,
        tokenExpiry: this.tokenExpiry
      }
    });

    return this.accessToken;
  }

  async createEvent(event: CalendarEvent, calendarId: string = 'primary', withMeet: boolean = false): Promise<CalendarEvent> {
    const token = await this.ensureValidToken();

    const url = withMeet 
      ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1`
      : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(event)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create event: ${error}`);
    }

    return response.json();
  }

  async updateEvent(eventId: string, event: Partial<CalendarEvent>, calendarId: string = 'primary'): Promise<CalendarEvent> {
    const token = await this.ensureValidToken();

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(event)
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update event: ${error}`);
    }

    return response.json();
  }

  async getFreeBusy(
    timeMin: string,
    timeMax: string,
    calendarId: string = 'primary'
  ): Promise<Array<{ start: string; end: string }>> {
    const token = await this.ensureValidToken();

    const response = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        timeMin,
        timeMax,
        items: [{ id: calendarId }]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get free/busy: ${error}`);
    }

    const data: FreeBusyResponse = await response.json();
    return data.calendars[calendarId]?.busy || [];
  }

  async listEvents(
    timeMin: string,
    timeMax: string,
    calendarId: string = 'primary'
  ): Promise<CalendarEvent[]> {
    const token = await this.ensureValidToken();

    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime'
    });

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list events: ${error}`);
    }

    const data = await response.json();
    return data.items || [];
  }

  async deleteEvent(eventId: string, calendarId: string = 'primary'): Promise<void> {
    const token = await this.ensureValidToken();

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      throw new Error(`Failed to delete event: ${error}`);
    }
  }
}

export async function getGoogleCalendarService(businessId: string): Promise<GoogleCalendarService | null> {
  const credential = await prisma.googleCalendarCredential.findUnique({
    where: { businessId }
  });

  if (!credential || !credential.syncEnabled) {
    return null;
  }

  return new GoogleCalendarService(
    businessId,
    credential.accessToken,
    credential.refreshToken,
    credential.tokenExpiry
  );
}

export async function createAppointmentInGoogleCalendar(
  businessId: string,
  appointment: {
    clientName: string;
    clientPhone: string;
    service?: string;
    dateTime: string;
    durationMinutes: number;
    notes?: string;
    guestEmail?: string;
    eventTitle?: string;
    createMeetLink?: boolean;
  },
  timezone: string = 'America/Lima'
): Promise<{ success: boolean; eventId?: string; meetingUrl?: string; error?: string }> {
  try {
    const service = await getGoogleCalendarService(businessId);
    if (!service) {
      return { success: false, error: 'Google Calendar not connected' };
    }

    const credential = await prisma.googleCalendarCredential.findUnique({
      where: { businessId }
    });

    const startDateTime = new Date(appointment.dateTime);
    const endDateTime = new Date(startDateTime.getTime() + appointment.durationMinutes * 60 * 1000);

    const defaultTitle = `Cita: ${appointment.clientName}${appointment.service ? ` - ${appointment.service}` : ''}`;
    
    const eventData: CalendarEvent = {
      summary: appointment.eventTitle || defaultTitle,
      description: [
        `Cliente: ${appointment.clientName}`,
        `Teléfono: ${appointment.clientPhone}`,
        appointment.service ? `Servicio: ${appointment.service}` : null,
        appointment.notes ? `Notas: ${appointment.notes}` : null
      ].filter(Boolean).join('\n'),
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: timezone
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: timezone
      }
    };

    if (appointment.guestEmail) {
      eventData.attendees = [{ 
        email: appointment.guestEmail,
        displayName: appointment.clientName
      }];
    }

    if (appointment.createMeetLink) {
      const requestId = `meet-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      eventData.conferenceData = {
        createRequest: {
          requestId,
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      };
    }

    const event = await service.createEvent(
      eventData, 
      credential?.calendarId || 'primary',
      !!appointment.createMeetLink
    );

    console.log(`[GoogleCalendar] Created event ${event.id}${event.hangoutLink ? ` with Meet link: ${event.hangoutLink}` : ''}`);

    return { 
      success: true, 
      eventId: event.id,
      meetingUrl: event.hangoutLink
    };
  } catch (error: any) {
    console.error('[GoogleCalendar] Failed to create event:', error.message);
    return { success: false, error: error.message };
  }
}

export async function getGoogleCalendarBusySlots(
  businessId: string,
  date: string,
  timezone: string = 'America/Lima'
): Promise<{ success: boolean; busySlots?: Array<{ start: string; end: string }>; error?: string }> {
  try {
    const service = await getGoogleCalendarService(businessId);
    if (!service) {
      return { success: true, busySlots: [] };
    }

    const credential = await prisma.googleCalendarCredential.findUnique({
      where: { businessId }
    });

    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(`${date}T23:59:59`);

    const busySlots = await service.getFreeBusy(
      dayStart.toISOString(),
      dayEnd.toISOString(),
      credential?.calendarId || 'primary'
    );

    return { success: true, busySlots };
  } catch (error: any) {
    console.error('[GoogleCalendar] Failed to get busy slots:', error.message);
    return { success: false, error: error.message };
  }
}

export async function updateAppointmentInGoogleCalendar(
  businessId: string,
  eventId: string,
  appointment: {
    clientName?: string;
    clientPhone?: string;
    service?: string;
    dateTime?: string;
    durationMinutes?: number;
    notes?: string;
    guestEmail?: string;
    eventTitle?: string;
  },
  timezone: string = 'America/Lima'
): Promise<{ success: boolean; error?: string }> {
  try {
    const service = await getGoogleCalendarService(businessId);
    if (!service) {
      return { success: false, error: 'Google Calendar not connected' };
    }

    const credential = await prisma.googleCalendarCredential.findUnique({
      where: { businessId }
    });

    const updateData: any = {};

    if (appointment.eventTitle) {
      updateData.summary = appointment.eventTitle;
    } else if (appointment.clientName || appointment.service) {
      updateData.summary = `Cita: ${appointment.clientName || 'Cliente'}${appointment.service ? ` - ${appointment.service}` : ''}`;
    }

    if (appointment.clientName || appointment.clientPhone || appointment.service || appointment.notes) {
      updateData.description = [
        appointment.clientName ? `Cliente: ${appointment.clientName}` : null,
        appointment.clientPhone ? `Teléfono: ${appointment.clientPhone}` : null,
        appointment.service ? `Servicio: ${appointment.service}` : null,
        appointment.notes ? `Notas: ${appointment.notes}` : null
      ].filter(Boolean).join('\n');
    }

    if (appointment.dateTime && appointment.durationMinutes) {
      const startDateTime = new Date(appointment.dateTime);
      const endDateTime = new Date(startDateTime.getTime() + appointment.durationMinutes * 60 * 1000);
      
      updateData.start = {
        dateTime: startDateTime.toISOString(),
        timeZone: timezone
      };
      updateData.end = {
        dateTime: endDateTime.toISOString(),
        timeZone: timezone
      };
    }

    if (appointment.guestEmail) {
      updateData.attendees = [{ 
        email: appointment.guestEmail,
        displayName: appointment.clientName
      }];
    }

    await service.updateEvent(eventId, updateData, credential?.calendarId || 'primary');
    return { success: true };
  } catch (error: any) {
    console.error('[GoogleCalendar] Failed to update event:', error.message);
    return { success: false, error: error.message };
  }
}

export async function deleteAppointmentFromGoogleCalendar(
  businessId: string,
  eventId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const service = await getGoogleCalendarService(businessId);
    if (!service) {
      return { success: false, error: 'Google Calendar not connected' };
    }

    const credential = await prisma.googleCalendarCredential.findUnique({
      where: { businessId }
    });

    await service.deleteEvent(eventId, credential?.calendarId || 'primary');
    return { success: true };
  } catch (error: any) {
    console.error('[GoogleCalendar] Failed to delete event:', error.message);
    return { success: false, error: error.message };
  }
}

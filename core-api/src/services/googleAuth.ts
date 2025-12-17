import { google } from 'googleapis';

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

function getRedirectUri(): string {
  const publicUrl = getPublicApiUrl();
  const uri = `${publicUrl}/auth/google/callback`;
  console.log('[GoogleAuth] Redirect URI:', uri);
  return uri;
}

export function isGoogleAuthConfigured(): boolean {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

export function getGoogleAuthClient() {
  if (!isGoogleAuthConfigured()) {
    throw new Error('Google Auth not configured');
  }
  
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    getRedirectUri()
  );
}

export function getGoogleAuthUrl(state: string): string {
  const oauth2Client = getGoogleAuthClient();
  
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    state,
    prompt: 'consent select_account'
  });
}

export interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

export async function getGoogleUserInfo(code: string): Promise<GoogleUserInfo> {
  const oauth2Client = getGoogleAuthClient();
  
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  
  if (!data.id || !data.email) {
    throw new Error('Failed to get user info from Google');
  }
  
  return {
    id: data.id,
    email: data.email,
    verified_email: data.verified_email || false,
    name: data.name || data.email.split('@')[0],
    given_name: data.given_name || undefined,
    family_name: data.family_name || undefined,
    picture: data.picture || undefined
  };
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

function getPublicApiUrl(): string {
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

export function getGoogleAuthUrl(state: string): string {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error('Google Client ID not configured');
  }

  const scopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ];

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  console.log('[GoogleAuth] Generated auth URL:', authUrl);
  return authUrl;
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

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
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
      redirect_uri: getRedirectUri(),
      grant_type: 'authorization_code'
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[GoogleAuth] Token exchange failed:', error);
    throw new Error(`Token exchange failed: ${error}`);
  }

  return response.json();
}

export async function getGoogleUserInfo(code: string): Promise<GoogleUserInfo> {
  const tokens = await exchangeCodeForTokens(code);
  
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[GoogleAuth] Failed to get user info:', error);
    throw new Error('Failed to get user info from Google');
  }

  const data = await response.json();
  
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

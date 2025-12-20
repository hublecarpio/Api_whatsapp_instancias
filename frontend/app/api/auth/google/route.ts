import { NextRequest, NextResponse } from 'next/server';

function getPublicBackendUrl(request: NextRequest): string {
  // Check for explicit public backend URL first (highest priority)
  if (process.env.NEXT_PUBLIC_BACKEND_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_URL;
  }
  
  // Dynamically derive API URL from current host
  // Pattern: app.domain.com -> api.domain.com
  // Pattern: domain.com -> api.domain.com
  const host = request.headers.get('host') || '';
  const protocol = request.headers.get('x-forwarded-proto') || 'https';
  
  if (host && !host.includes('localhost')) {
    // Replace 'app.' prefix with 'api.' or add 'api.' if no prefix
    let apiHost = host;
    if (host.startsWith('app.')) {
      apiHost = host.replace('app.', 'api.');
    } else {
      // Add api. prefix to the domain
      apiHost = `api.${host}`;
    }
    return `${protocol}://${apiHost}`;
  }
  
  // Fallback for local development
  return 'http://localhost:3001';
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const referralCode = searchParams.get('referralCode');
  
  const backendUrl = getPublicBackendUrl(request);
  const googleAuthUrl = `${backendUrl}/auth/google${referralCode ? `?referralCode=${referralCode}` : ''}`;
  
  console.log('[Google OAuth] Redirecting to:', googleAuthUrl);
  
  return NextResponse.redirect(googleAuthUrl);
}

export async function POST(request: NextRequest) {
  return GET(request);
}

import { NextRequest, NextResponse } from 'next/server';

function getPublicBackendUrl(request: NextRequest): string {
  // For production, use the public API URL based on the request host
  const host = request.headers.get('host') || '';
  
  // If we're on app.efficore.es, redirect to api.efficore.es
  if (host.includes('efficore.es')) {
    return 'https://api.efficore.es';
  }
  
  // Check for explicit public backend URL
  if (process.env.NEXT_PUBLIC_BACKEND_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_URL;
  }
  
  // For development, construct URL from current host
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
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

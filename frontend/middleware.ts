import { NextRequest, NextResponse } from 'next/server';

function getCoreApiUrl(): string {
  return process.env.CORE_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
}

export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const apiUrl = getCoreApiUrl();
    const path = request.nextUrl.pathname.replace('/api', '');
    const targetUrl = `${apiUrl}${path}${request.nextUrl.search}`;
    
    try {
      const headers = new Headers();
      const hopByHopHeaders = ['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade'];
      
      request.headers.forEach((value, key) => {
        if (!hopByHopHeaders.includes(key.toLowerCase())) {
          headers.set(key, value);
        }
      });
      
      const methodsWithoutBody = ['GET', 'HEAD', 'DELETE', 'OPTIONS'];
      const hasBody = !methodsWithoutBody.includes(request.method);
      
      const fetchOptions: RequestInit & { duplex?: 'half' } = {
        method: request.method,
        headers: headers,
      };
      
      if (hasBody && request.body) {
        fetchOptions.body = request.body;
        fetchOptions.duplex = 'half';
      }
      
      const response = await fetch(targetUrl, fetchOptions);
      
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('transfer-encoding');
      responseHeaders.delete('connection');
      
      if (response.status === 204 || response.status === 304) {
        return new NextResponse(null, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      }
      
      return new NextResponse(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      console.error('Proxy error:', error);
      return NextResponse.json(
        { error: 'Backend service unavailable' },
        { status: 503 }
      );
    }
  }
  
  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};

import { NextRequest, NextResponse } from 'next/server';

export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const apiUrl = process.env.CORE_API_URL || 'http://localhost:3001';
    const path = request.nextUrl.pathname.replace('/api', '');
    const targetUrl = `${apiUrl}${path}${request.nextUrl.search}`;
    
    try {
      const headers = new Headers();
      request.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'content-length') {
          headers.set(key, value);
        }
      });
      
      let body: string | undefined = undefined;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        body = await request.text();
      }
      
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: headers,
        body: body,
      });
      
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('transfer-encoding');
      
      return new NextResponse(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      console.error('Proxy error: ', error);
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

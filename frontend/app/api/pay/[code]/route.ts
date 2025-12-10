import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  request: NextRequest,
  { params }: { params: { code: string } }
) {
  try {
    const code = params.code;
    
    if (!code) {
      return NextResponse.json(
        { success: false, error: 'Código de pago no válido' },
        { status: 400 }
      );
    }

    const apiUrl = process.env.CORE_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    
    const response = await fetch(`${apiUrl}/orders/pay/${code}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store'
    });

    const data = await response.json();
    
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[API PAY] Error fetching payment URL:', error);
    return NextResponse.json(
      { success: false, error: 'Error al procesar el enlace de pago' },
      { status: 500 }
    );
  }
}

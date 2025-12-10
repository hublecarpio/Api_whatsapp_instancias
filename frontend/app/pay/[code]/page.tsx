'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function PaymentRedirectPage() {
  const params = useParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const code = params.code as string;
    if (!code) {
      setError('Código de pago no válido');
      setLoading(false);
      return;
    }

    const fetchPaymentUrl = async () => {
      try {
        const response = await fetch(`/api/orders/pay/${code}`);
        const data = await response.json();

        if (data.success && data.paymentUrl) {
          window.location.href = data.paymentUrl;
        } else {
          setError(data.error || 'Enlace de pago no encontrado o expirado');
          setLoading(false);
        }
      } catch (err) {
        console.error('Error fetching payment URL:', err);
        setError('Error al procesar el enlace de pago');
        setLoading(false);
      }
    };

    fetchPaymentUrl();
  }, [params.code]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-20 h-20 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
            <svg className="w-10 h-10 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <p className="text-white text-xl font-semibold mb-2">Redirigiendo...</p>
          <p className="text-emerald-400 text-sm flex items-center justify-center gap-2">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
            Link de pago seguro
          </p>
          <div className="mt-6 flex items-center justify-center gap-2 text-gray-500 text-xs">
            <span>Procesado por</span>
            <svg className="h-5" viewBox="0 0 60 25" fill="currentColor">
              <path d="M59.64 14.28h-8.06c.19 1.93 1.6 2.55 3.2 2.55 1.64 0 2.96-.37 4.05-.95v3.32a10.37 10.37 0 0 1-4.56 1c-4.01 0-6.83-2.5-6.83-7.48 0-4.19 2.39-7.52 6.3-7.52 3.92 0 5.96 3.28 5.96 7.5 0 .4-.04 1.26-.06 1.58zm-5.92-5.62c-1.03 0-2.17.73-2.17 2.58h4.25c0-1.85-1.07-2.58-2.08-2.58zM41.49 20h4.15V5.57h-4.15V20zm0-16.47c0-1.3 1.03-2.35 2.3-2.35 1.26 0 2.29 1.05 2.29 2.35 0 1.3-1.03 2.35-2.29 2.35-1.27 0-2.3-1.05-2.3-2.35zM33.39 20V5.57h3.96v1.64c.98-1.16 2.47-1.9 4.2-1.9v4.07c-.23-.04-.47-.06-.75-.06-1.26 0-2.73.6-3.41 1.24V20h-4zM23.78 8.74h-2.46V5.67h2.46V2.19h4.13v3.48h3.01v3.07h-3.01v6.14c0 1.42.6 1.93 1.66 1.93.5 0 1.08-.08 1.35-.17v3.36c-.47.17-1.3.3-2.3.3-3.03 0-4.84-1.46-4.84-4.89V8.74zM10.92 10.37c-1.54-.55-2.13-.95-2.13-1.68 0-.63.52-1.1 1.5-1.1 1.26 0 2.56.53 3.56 1.12l1.35-3.15a10.24 10.24 0 0 0-4.76-1.26c-3.36 0-5.73 1.86-5.73 4.67 0 2.26 1.46 3.62 4.16 4.53 1.84.63 2.39 1.1 2.39 1.84 0 .73-.63 1.21-1.76 1.21-1.54 0-3.32-.71-4.63-1.68L3.14 18c1.64 1.31 4.07 2.16 6.27 2.16 3.7 0 5.97-1.87 5.97-4.8 0-2.6-1.67-3.8-4.46-4.99z"/>
            </svg>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800 rounded-xl p-8 max-w-md w-full text-center border border-gray-700">
          <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-white mb-2">Enlace no disponible</h1>
          <p className="text-gray-400 mb-6">{error}</p>
          <p className="text-sm text-gray-500">
            Si crees que esto es un error, contacta al vendedor para obtener un nuevo enlace de pago.
          </p>
        </div>
      </div>
    );
  }

  return null;
}

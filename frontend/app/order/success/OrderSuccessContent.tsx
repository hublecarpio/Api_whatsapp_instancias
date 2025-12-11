'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

interface OrderDetails {
  orderId: string;
  totalAmount: number;
  currencySymbol: string;
  contactName: string;
  items: Array<{
    productTitle: string;
    quantity: number;
    unitPrice: number;
  }>;
}

export default function OrderSuccessContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [order, setOrder] = useState<OrderDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setError('No se encontró información del pago');
      setLoading(false);
      return;
    }

    const fetchOrderDetails = async () => {
      try {
        const response = await fetch(`/api/orders/details/${sessionId}`);
        const data = await response.json();

        if (data.success && data.order) {
          setOrder(data.order);
        } else {
          setError(data.error || 'No se pudo obtener los detalles del pedido');
        }
      } catch (err) {
        console.error('Error fetching order:', err);
        setError('Error al cargar los detalles del pedido');
      } finally {
        setLoading(false);
      }
    };

    fetchOrderDetails();
  }, [sessionId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-white text-lg">Procesando tu pago...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center p-4">
      <div className="bg-gray-800 rounded-2xl p-8 max-w-lg w-full border border-gray-700 shadow-2xl">
        <div className="text-center">
          <div className="w-20 h-20 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-10 h-10 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          
          <h1 className="text-2xl font-bold text-white mb-2">Pago Exitoso</h1>
          <p className="text-gray-400 mb-6">Tu pedido ha sido confirmado</p>

          {order && (
            <div className="bg-gray-900/50 rounded-xl p-6 text-left mb-6">
              <div className="flex justify-between items-center mb-4 pb-4 border-b border-gray-700">
                <span className="text-gray-400">N° Pedido</span>
                <span className="text-white font-mono text-sm">{order.orderId.slice(0, 8).toUpperCase()}</span>
              </div>

              {order.contactName && (
                <div className="flex justify-between items-center mb-4 pb-4 border-b border-gray-700">
                  <span className="text-gray-400">Cliente</span>
                  <span className="text-white">{order.contactName}</span>
                </div>
              )}

              <div className="space-y-3 mb-4 pb-4 border-b border-gray-700">
                <p className="text-gray-400 text-sm mb-2">Productos:</p>
                {order.items.map((item, idx) => (
                  <div key={idx} className="flex justify-between items-center">
                    <span className="text-white">{item.quantity}x {item.productTitle}</span>
                    <span className="text-gray-300">{order.currencySymbol}{(item.unitPrice * item.quantity).toFixed(2)}</span>
                  </div>
                ))}
              </div>

              <div className="flex justify-between items-center">
                <span className="text-lg font-semibold text-white">Total</span>
                <span className="text-xl font-bold text-emerald-400">{order.currencySymbol}{order.totalAmount.toFixed(2)}</span>
              </div>
            </div>
          )}

          {error && (
            <div className="bg-yellow-500/20 rounded-xl p-4 mb-6">
              <p className="text-yellow-300 text-sm">{error}</p>
              <p className="text-yellow-200/70 text-xs mt-1">Tu pago fue procesado correctamente.</p>
            </div>
          )}

          <p className="text-gray-400 text-sm mb-6">
            Recibirás una confirmación por WhatsApp con los detalles de tu pedido.
          </p>

          <div className="text-gray-500 text-xs">
            Puedes cerrar esta ventana de forma segura.
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';

export default function OrderCancelPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center p-4">
      <div className="bg-gray-800 rounded-2xl p-8 max-w-lg w-full border border-gray-700 shadow-2xl">
        <div className="text-center">
          <div className="w-20 h-20 bg-yellow-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-10 h-10 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          
          <h1 className="text-2xl font-bold text-white mb-2">Pago Cancelado</h1>
          <p className="text-gray-400 mb-6">El proceso de pago fue interrumpido</p>

          <div className="bg-gray-900/50 rounded-xl p-6 mb-6">
            <p className="text-gray-300 text-sm">
              No se realizó ningún cargo a tu tarjeta. Si deseas completar tu compra, 
              puedes solicitar un nuevo enlace de pago.
            </p>
          </div>

          <p className="text-gray-500 text-sm">
            Contacta al vendedor por WhatsApp para obtener un nuevo enlace de pago.
          </p>

          <div className="mt-6 text-gray-500 text-xs">
            Puedes cerrar esta ventana de forma segura.
          </div>
        </div>
      </div>
    </div>
  );
}

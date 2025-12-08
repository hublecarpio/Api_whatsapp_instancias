'use client';

import { useState } from 'react';
import { billingApi } from '@/lib/api';

interface PaymentGateProps {
  isOpen: boolean;
  subscriptionStatus: string;
  trialDaysRemaining?: number | null;
}

export default function PaymentGate({ isOpen, subscriptionStatus, trialDaysRemaining }: PaymentGateProps) {
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleStartTrial = async () => {
    setLoading(true);
    try {
      const response = await billingApi.createCheckoutSession();
      if (response.data.url) {
        window.location.href = response.data.url;
      }
    } catch (error) {
      console.error('Error creating checkout session:', error);
    } finally {
      setLoading(false);
    }
  };

  const getContent = () => {
    switch (subscriptionStatus) {
      case 'pending':
        return {
          title: 'Activa tu cuenta',
          subtitle: 'Agrega un metodo de pago para comenzar tu prueba gratuita de 7 dias',
          buttonText: 'Comenzar prueba gratuita',
          description: 'No se realizara ningun cargo durante el periodo de prueba. Puedes cancelar en cualquier momento.'
        };
      case 'past_due':
        return {
          title: 'Pago pendiente',
          subtitle: 'Tu ultimo pago no pudo procesarse',
          buttonText: 'Actualizar metodo de pago',
          description: 'Por favor actualiza tu informacion de pago para continuar usando la plataforma.'
        };
      case 'canceled':
        return {
          title: 'Suscripcion cancelada',
          subtitle: 'Tu suscripcion ha sido cancelada',
          buttonText: 'Reactivar suscripcion',
          description: 'Reactiva tu suscripcion para recuperar el acceso a todas las funciones.'
        };
      default:
        return {
          title: 'Acceso requerido',
          subtitle: 'Se requiere una suscripcion activa',
          buttonText: 'Suscribirse',
          description: 'Activa tu suscripcion para acceder a la plataforma.'
        };
    }
  };

  const content = getContent();

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-10rem)]">
      <div className="w-full max-w-md mx-auto">
        <div className="bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden">
          <div className="p-8 text-center">
            <div className="w-16 h-16 mx-auto mb-6 bg-gradient-to-br from-green-400 to-green-600 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>

            <h2 className="text-2xl font-bold text-gray-900 mb-2">
              {content.title}
            </h2>
            
            <p className="text-gray-600 mb-6">
              {content.subtitle}
            </p>

            <button
              onClick={handleStartTrial}
              disabled={loading}
              className="w-full py-4 px-6 bg-gradient-to-r from-green-500 to-green-600 text-white font-semibold rounded-xl shadow-lg hover:from-green-600 hover:to-green-700 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed transform hover:scale-[1.02] active:scale-[0.98]"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Procesando...
                </span>
              ) : (
                content.buttonText
              )}
            </button>

            <p className="mt-4 text-sm text-gray-500">
              {content.description}
            </p>

            {subscriptionStatus === 'pending' && (
              <div className="mt-6 pt-6 border-t border-gray-100">
                <div className="flex items-center justify-center gap-2 text-sm text-gray-500">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  <span>Pago seguro con Stripe</span>
                </div>
                <div className="mt-2 text-xs text-gray-400">
                  $50 USD/semana despues del periodo de prueba
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

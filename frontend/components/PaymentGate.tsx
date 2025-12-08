'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { billingApi } from '@/lib/api';
import Logo from './Logo';

interface PaymentGateProps {
  isOpen: boolean;
  subscriptionStatus: string;
  trialDaysRemaining?: number | null;
}

export default function PaymentGate({ isOpen, subscriptionStatus, trialDaysRemaining }: PaymentGateProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleStartTrial = async () => {
    setLoading(true);
    setError('');
    
    try {
      const response = await billingApi.createCheckoutSession();
      if (response.data.url) {
        window.location.href = response.data.url;
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al crear sesion de pago');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const getStatusMessage = () => {
    switch (subscriptionStatus) {
      case 'pending':
        return {
          title: 'Activa tu cuenta',
          description: 'Para acceder a todas las funciones de EfficioreChat, necesitas registrar un metodo de pago.',
          action: 'Iniciar periodo de prueba',
          highlight: 'Prueba gratis por 7 dias, luego $50 USD/semana'
        };
      case 'past_due':
        return {
          title: 'Pago pendiente',
          description: 'Tu ultimo pago no se pudo procesar. Actualiza tu metodo de pago para continuar usando la plataforma.',
          action: 'Actualizar metodo de pago',
          highlight: 'Tu acceso esta temporalmente suspendido'
        };
      case 'canceled':
        return {
          title: 'Suscripcion cancelada',
          description: 'Tu suscripcion ha sido cancelada. Reactiva tu cuenta para continuar usando todas las funciones.',
          action: 'Reactivar suscripcion',
          highlight: 'Puedes reactivar en cualquier momento'
        };
      default:
        return {
          title: 'Configura tu cuenta',
          description: 'Completa la configuracion de tu cuenta para comenzar.',
          action: 'Continuar',
          highlight: ''
        };
    }
  };

  const status = getStatusMessage();

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-4">
      <div className="card max-w-md w-full text-center">
        <div className="mb-6 flex justify-center">
          <Logo size="lg" />
        </div>

        <div className="w-16 h-16 mx-auto mb-6 bg-neon-blue/10 rounded-full flex items-center justify-center">
          <svg className="w-8 h-8 text-neon-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>

        <h2 className="text-2xl font-bold text-white mb-3">
          {status.title}
        </h2>
        
        <p className="text-gray-400 mb-6">
          {status.description}
        </p>

        {status.highlight && (
          <div className="bg-neon-blue/10 border border-neon-blue/20 rounded-lg px-4 py-3 mb-6">
            <p className="text-neon-blue text-sm font-medium">
              {status.highlight}
            </p>
          </div>
        )}

        {error && (
          <div className="bg-accent-error/10 border border-accent-error/20 rounded-lg px-4 py-3 mb-6">
            <p className="text-accent-error text-sm">{error}</p>
          </div>
        )}

        <button
          onClick={handleStartTrial}
          disabled={loading}
          className="btn btn-primary w-full mb-4"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Procesando...
            </span>
          ) : (
            status.action
          )}
        </button>

        <button
          onClick={() => router.push('/dashboard/billing')}
          className="btn btn-ghost w-full text-sm"
        >
          Ver opciones de facturacion
        </button>

        <div className="mt-6 pt-6 border-t border-dark-border">
          <div className="flex items-center justify-center gap-4 text-xs text-gray-500">
            <div className="flex items-center gap-1">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              Pago seguro
            </div>
            <div className="flex items-center gap-1">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Cancela cuando quieras
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

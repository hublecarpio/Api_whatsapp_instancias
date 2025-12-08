'use client';

import { useState, useEffect } from 'react';
import { billingApi } from '@/lib/api';

interface SubscriptionStatus {
  subscriptionStatus: 'pending' | 'trial' | 'active' | 'past_due' | 'canceled';
  trialEndAt: string | null;
  nextPayment: string | null;
  hasSubscription: boolean;
}

export default function BillingPage() {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    loadSubscriptionStatus();
  }, []);

  const loadSubscriptionStatus = async () => {
    try {
      const res = await billingApi.getSubscriptionStatus();
      setStatus(res.data);
    } catch (error) {
      console.error('Error loading subscription status:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubscribe = async () => {
    setActionLoading(true);
    try {
      const res = await billingApi.createCheckoutSession();
      if (res.data.url) {
        window.location.href = res.data.url;
      }
    } catch (error) {
      console.error('Error creating checkout session:', error);
      alert('Error al crear la sesion de pago');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!confirm('Estas seguro que deseas cancelar tu suscripcion? Mantendras acceso hasta el final del periodo actual.')) {
      return;
    }
    
    setActionLoading(true);
    try {
      await billingApi.cancelSubscription();
      await loadSubscriptionStatus();
      alert('Suscripcion cancelada. Mantendras acceso hasta el final del periodo.');
    } catch (error) {
      console.error('Error canceling subscription:', error);
      alert('Error al cancelar la suscripcion');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReactivate = async () => {
    setActionLoading(true);
    try {
      await billingApi.reactivateSubscription();
      await loadSubscriptionStatus();
      alert('Suscripcion reactivada exitosamente!');
    } catch (error) {
      console.error('Error reactivating subscription:', error);
      alert('Error al reactivar la suscripcion');
    } finally {
      setActionLoading(false);
    }
  };

  const getStatusBadge = () => {
    if (!status) return null;

    const badges: Record<string, { color: string; text: string }> = {
      pending: { color: 'bg-gray-500', text: 'Sin suscripcion' },
      trial: { color: 'bg-blue-500', text: 'Periodo de prueba' },
      active: { color: 'bg-green-500', text: 'Activa' },
      past_due: { color: 'bg-yellow-500', text: 'Pago pendiente' },
      canceled: { color: 'bg-red-500', text: 'Cancelada' }
    };

    const badge = badges[status.subscriptionStatus] || badges.pending;
    
    return (
      <span className={`${badge.color} text-white px-3 py-1 rounded-full text-sm font-medium`}>
        {badge.text}
      </span>
    );
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-700 rounded w-48 mb-6"></div>
          <div className="h-64 bg-gray-800 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-6">Facturacion y Suscripcion</h1>

      <div className="bg-gray-800 rounded-lg p-6 mb-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-white mb-2">Estado de tu suscripcion</h2>
            {getStatusBadge()}
          </div>
          <div className="text-right">
            <p className="text-gray-400 text-sm">Plan actual</p>
            <p className="text-white text-xl font-bold">$50 USD / semana</p>
          </div>
        </div>

        {status?.subscriptionStatus === 'trial' && status.trialEndAt && (
          <div className="bg-blue-900/30 border border-blue-500 rounded-lg p-4 mb-4">
            <p className="text-blue-400">
              Tu periodo de prueba termina el <strong>{formatDate(status.trialEndAt)}</strong>
            </p>
            <p className="text-blue-300 text-sm mt-1">
              Despues de esta fecha se realizara el primer cobro de $50 USD.
            </p>
          </div>
        )}

        {status?.subscriptionStatus === 'active' && status.nextPayment && (
          <div className="bg-gray-700 rounded-lg p-4 mb-4">
            <div className="flex justify-between">
              <span className="text-gray-400">Proximo pago:</span>
              <span className="text-white font-medium">{formatDate(status.nextPayment)}</span>
            </div>
          </div>
        )}

        {status?.subscriptionStatus === 'past_due' && (
          <div className="bg-yellow-900/30 border border-yellow-500 rounded-lg p-4 mb-4">
            <p className="text-yellow-400 font-medium">Pago fallido</p>
            <p className="text-yellow-300 text-sm mt-1">
              Tu ultimo pago no pudo ser procesado. Actualiza tu metodo de pago para mantener el acceso.
            </p>
          </div>
        )}

        {status?.subscriptionStatus === 'canceled' && (
          <div className="bg-red-900/30 border border-red-500 rounded-lg p-4 mb-4">
            <p className="text-red-400 font-medium">Suscripcion cancelada</p>
            <p className="text-red-300 text-sm mt-1">
              Tu suscripcion ha sido cancelada. Suscribete nuevamente para continuar usando el servicio.
            </p>
          </div>
        )}

        <div className="flex gap-4 mt-6">
          {(status?.subscriptionStatus === 'pending' || status?.subscriptionStatus === 'canceled') && (
            <button
              onClick={handleSubscribe}
              disabled={actionLoading}
              className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-6 py-3 rounded-lg font-medium transition-colors"
            >
              {actionLoading ? 'Procesando...' : 'Iniciar suscripcion con 7 dias gratis'}
            </button>
          )}

          {status?.subscriptionStatus === 'past_due' && (
            <button
              onClick={handleSubscribe}
              disabled={actionLoading}
              className="bg-yellow-600 hover:bg-yellow-700 disabled:opacity-50 text-white px-6 py-3 rounded-lg font-medium transition-colors"
            >
              {actionLoading ? 'Procesando...' : 'Actualizar metodo de pago'}
            </button>
          )}

          {(status?.subscriptionStatus === 'trial' || status?.subscriptionStatus === 'active') && (
            <button
              onClick={handleCancel}
              disabled={actionLoading}
              className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-6 py-3 rounded-lg font-medium transition-colors"
            >
              {actionLoading ? 'Procesando...' : 'Cancelar suscripcion'}
            </button>
          )}
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Que incluye tu plan?</h2>
        <ul className="space-y-3">
          <li className="flex items-center text-gray-300">
            <svg className="w-5 h-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            Conexion WhatsApp ilimitada
          </li>
          <li className="flex items-center text-gray-300">
            <svg className="w-5 h-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            Agente IA con OpenAI integrado
          </li>
          <li className="flex items-center text-gray-300">
            <svg className="w-5 h-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            Gestion de productos y catalogo
          </li>
          <li className="flex items-center text-gray-300">
            <svg className="w-5 h-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            Seguimientos automaticos
          </li>
          <li className="flex items-center text-gray-300">
            <svg className="w-5 h-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            Etiquetas y CRM de clientes
          </li>
          <li className="flex items-center text-gray-300">
            <svg className="w-5 h-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            Soporte para Meta Cloud API
          </li>
        </ul>
      </div>
    </div>
  );
}

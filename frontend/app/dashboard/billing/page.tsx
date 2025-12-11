'use client';

import { useState, useEffect } from 'react';
import { billingApi, authApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';

interface SubscriptionStatus {
  subscriptionStatus: 'pending' | 'trial' | 'active' | 'past_due' | 'canceled';
  trialEndAt: string | null;
  nextPayment: string | null;
  hasSubscription: boolean;
  proBonusExpiresAt?: string | null;
  hasActiveBonus?: boolean;
}

export default function BillingPage() {
  const { user, updateUser } = useAuthStore();
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [referralCode, setReferralCode] = useState('');
  const [referralLoading, setReferralLoading] = useState(false);
  const [referralMessage, setReferralMessage] = useState<{type: 'success' | 'error', text: string} | null>(null);

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

  const handleApplyReferral = async () => {
    if (!referralCode.trim()) {
      setReferralMessage({ type: 'error', text: 'Ingresa un codigo de referido' });
      return;
    }
    
    setReferralLoading(true);
    setReferralMessage(null);
    
    try {
      const response = await authApi.applyReferral(referralCode.trim());
      setReferralMessage({ type: 'success', text: response.data.message });
      setReferralCode('');
      
      const meResponse = await authApi.me();
      updateUser(meResponse.data);
      
      await loadSubscriptionStatus();
    } catch (error: any) {
      const errorMsg = error.response?.data?.error || 'Error al aplicar el codigo';
      setReferralMessage({ type: 'error', text: errorMsg });
    } finally {
      setReferralLoading(false);
    }
  };

  const getStatusBadge = () => {
    if (!status) return null;

    const badges: Record<string, { color: string; text: string }> = {
      pending: { color: 'bg-gray-500', text: 'Sin suscripcion' },
      trial: { color: 'bg-neon-blue', text: 'Periodo de prueba' },
      active: { color: 'bg-accent-success', text: 'Activa' },
      past_due: { color: 'bg-accent-warning', text: 'Pago pendiente' },
      canceled: { color: 'bg-accent-error', text: 'Cancelada' }
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
      <div className="p-4 sm:p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-dark-card rounded w-48 mb-6"></div>
          <div className="h-64 bg-dark-surface rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <h1 className="text-xl sm:text-2xl font-bold text-white mb-6">Facturacion y Suscripcion</h1>

      <div className="card mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h2 className="text-lg font-semibold text-white mb-2">Estado de tu suscripcion</h2>
            {getStatusBadge()}
          </div>
          <div className="sm:text-right">
            <p className="text-gray-400 text-sm">Plan actual</p>
            <p className="text-white text-xl font-bold">$50 USD / semana</p>
          </div>
        </div>

        {status?.subscriptionStatus === 'trial' && status.trialEndAt && (
          <div className="bg-neon-blue/10 border border-neon-blue/30 rounded-lg p-4 mb-4">
            <p className="text-neon-blue">
              Tu periodo de prueba termina el <strong>{formatDate(status.trialEndAt)}</strong>
            </p>
            <p className="text-neon-blue/70 text-sm mt-1">
              Despues de esta fecha se realizara el primer cobro de $50 USD.
            </p>
          </div>
        )}

        {status?.subscriptionStatus === 'active' && status.nextPayment && (
          <div className="bg-dark-hover rounded-lg p-4 mb-4">
            <div className="flex justify-between">
              <span className="text-gray-400">Proximo pago:</span>
              <span className="text-white font-medium">{formatDate(status.nextPayment)}</span>
            </div>
          </div>
        )}

        {status?.subscriptionStatus === 'past_due' && (
          <div className="bg-accent-warning/10 border border-accent-warning/30 rounded-lg p-4 mb-4">
            <p className="text-accent-warning font-medium">Pago fallido</p>
            <p className="text-accent-warning/70 text-sm mt-1">
              Tu ultimo pago no pudo ser procesado. Actualiza tu metodo de pago para mantener el acceso.
            </p>
          </div>
        )}

        {status?.subscriptionStatus === 'canceled' && (
          <div className="bg-accent-error/10 border border-accent-error/30 rounded-lg p-4 mb-4">
            <p className="text-accent-error font-medium">Suscripcion cancelada</p>
            <p className="text-accent-error/70 text-sm mt-1">
              Tu suscripcion ha sido cancelada. Suscribete nuevamente para continuar usando el servicio.
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-3 mt-6">
          {(status?.subscriptionStatus === 'pending' || status?.subscriptionStatus === 'canceled') && (
            <button
              onClick={handleSubscribe}
              disabled={actionLoading}
              className="btn btn-primary"
            >
              {actionLoading ? 'Procesando...' : 'Iniciar suscripcion con 7 dias gratis'}
            </button>
          )}

          {status?.subscriptionStatus === 'past_due' && (
            <button
              onClick={handleSubscribe}
              disabled={actionLoading}
              className="bg-accent-warning hover:bg-yellow-600 disabled:opacity-50 text-dark-bg px-6 py-3 rounded-lg font-medium transition-colors"
            >
              {actionLoading ? 'Procesando...' : 'Actualizar metodo de pago'}
            </button>
          )}

          {(status?.subscriptionStatus === 'trial' || status?.subscriptionStatus === 'active') && (
            <button
              onClick={handleCancel}
              disabled={actionLoading}
              className="btn btn-danger"
            >
              {actionLoading ? 'Procesando...' : 'Cancelar suscripcion'}
            </button>
          )}
        </div>
      </div>

      <div className="card mb-6">
        <h2 className="text-lg font-semibold text-white mb-2">Codigo de Referido</h2>
        <p className="text-gray-400 text-sm mb-4">
          Si tienes un codigo de referido, ingrésalo aqui para obtener dias de prueba Pro gratis.
        </p>
        
        {user?.proBonusExpiresAt && new Date(user.proBonusExpiresAt) > new Date() && (
          <div className="bg-accent-primary/10 border border-accent-primary/30 rounded-lg p-4 mb-4">
            <p className="text-accent-primary font-medium flex items-center gap-2">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              Bonus Pro Activo
            </p>
            <p className="text-accent-primary/70 text-sm mt-1">
              Tienes acceso Pro hasta el <strong>{formatDate(user.proBonusExpiresAt)}</strong>
            </p>
          </div>
        )}
        
        {(!user?.proBonusExpiresAt || new Date(user.proBonusExpiresAt) <= new Date()) && (
          <div className="flex gap-3">
            <input
              type="text"
              value={referralCode}
              onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
              placeholder="Ingresa tu codigo"
              className="flex-1 bg-dark-hover border border-gray-600 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-accent-primary"
            />
            <button
              onClick={handleApplyReferral}
              disabled={referralLoading}
              className="btn btn-primary whitespace-nowrap"
            >
              {referralLoading ? 'Aplicando...' : 'Aplicar Codigo'}
            </button>
          </div>
        )}
        
        {referralMessage && (
          <div className={`mt-3 p-3 rounded-lg ${
            referralMessage.type === 'success' 
              ? 'bg-accent-success/10 border border-accent-success/30 text-accent-success' 
              : 'bg-accent-error/10 border border-accent-error/30 text-accent-error'
          }`}>
            {referralMessage.text}
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="text-lg font-semibold text-white mb-4">Que incluye tu plan?</h2>
        <ul className="space-y-3">
          {[
            'Conexion WhatsApp ilimitada',
            'Agente IA con OpenAI integrado',
            'Gestion de productos y catalogo',
            'Seguimientos automaticos',
            'Etiquetas y CRM de clientes',
            'Soporte para Meta Cloud API'
          ].map((item, i) => (
            <li key={i} className="flex items-center text-gray-300">
              <svg className="w-5 h-5 text-accent-success mr-3 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

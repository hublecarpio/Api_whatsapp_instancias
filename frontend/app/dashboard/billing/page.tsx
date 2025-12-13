'use client';

import { useState, useEffect } from 'react';
import { billingApi, authApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import HubleFooter from '@/components/HubleFooter';

interface SubscriptionStatus {
  subscriptionStatus: 'pending' | 'trial' | 'active' | 'past_due' | 'canceled';
  trialEndAt: string | null;
  nextPayment: string | null;
  hasSubscription: boolean;
  proBonusExpiresAt?: string | null;
  hasActiveBonus?: boolean;
}

interface TokenUsage {
  tokensUsed: number;
  tokenLimit: number;
  baseLimit: number;
  bonusTokens: number;
  percentUsed: number;
  isOverLimit: boolean;
  canUseAI: boolean;
  tokensRemaining: number;
  message?: string;
}

export default function BillingPage() {
  const { user, updateUser } = useAuthStore();
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [referralCode, setReferralCode] = useState('');
  const [referralLoading, setReferralLoading] = useState(false);
  const [referralMessage, setReferralMessage] = useState<{type: 'success' | 'error', text: string} | null>(null);
  const [showEnterpriseModal, setShowEnterpriseModal] = useState(false);
  const [enterpriseForm, setEnterpriseForm] = useState({ businessDescription: '', companySize: '', useCase: '' });
  const [enterpriseLoading, setEnterpriseLoading] = useState(false);
  const [enterpriseMessage, setEnterpriseMessage] = useState<{type: 'success' | 'error', text: string} | null>(null);
  const [creditsLoading, setCreditsLoading] = useState(false);
  const [creditsMessage, setCreditsMessage] = useState<{type: 'success' | 'error', text: string} | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [statusRes, tokenRes] = await Promise.all([
        billingApi.getSubscriptionStatus(),
        billingApi.getTokenUsage()
      ]);
      setStatus(statusRes.data);
      setTokenUsage(tokenRes.data);
    } catch (error) {
      console.error('Error loading billing data:', error);
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
      await loadData();
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
      await loadData();
      alert('Suscripcion reactivada exitosamente!');
    } catch (error) {
      console.error('Error reactivating subscription:', error);
      alert('Error al reactivar la suscripcion');
    } finally {
      setActionLoading(false);
    }
  };

  const handleOpenPortal = async () => {
    setPortalLoading(true);
    try {
      const res = await billingApi.openPortal();
      if (res.data.url) {
        window.location.href = res.data.url;
      }
    } catch (error: any) {
      console.error('Error opening billing portal:', error);
      alert(error.response?.data?.error || 'Error al abrir el portal de facturacion');
    } finally {
      setPortalLoading(false);
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
      
      await loadData();
    } catch (error: any) {
      const errorMsg = error.response?.data?.error || 'Error al aplicar el codigo';
      setReferralMessage({ type: 'error', text: errorMsg });
    } finally {
      setReferralLoading(false);
    }
  };

  const handleEnterpriseRequest = async () => {
    if (!enterpriseForm.businessDescription.trim()) {
      setEnterpriseMessage({ type: 'error', text: 'Por favor describe tu negocio' });
      return;
    }

    setEnterpriseLoading(true);
    setEnterpriseMessage(null);

    try {
      await billingApi.enterpriseRequest(enterpriseForm);
      setEnterpriseMessage({ type: 'success', text: 'Solicitud enviada exitosamente. Nos pondremos en contacto contigo pronto.' });
      setEnterpriseForm({ businessDescription: '', companySize: '', useCase: '' });
      setTimeout(() => {
        setShowEnterpriseModal(false);
        setEnterpriseMessage(null);
      }, 3000);
    } catch (error: any) {
      const errorMsg = error.response?.data?.error || 'Error al enviar la solicitud';
      setEnterpriseMessage({ type: 'error', text: errorMsg });
    } finally {
      setEnterpriseLoading(false);
    }
  };

  const handlePurchaseCredits = async () => {
    if (!confirm('Se cobraran $5 USD a tu tarjeta guardada por 1M tokens adicionales. Continuar?')) {
      return;
    }

    setCreditsLoading(true);
    setCreditsMessage(null);

    try {
      const response = await billingApi.purchaseCredits();
      setCreditsMessage({ type: 'success', text: response.data.message });
      await loadData();
    } catch (error: any) {
      const errorMsg = error.response?.data?.error || 'Error al comprar creditos';
      setCreditsMessage({ type: 'error', text: errorMsg });
    } finally {
      setCreditsLoading(false);
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

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    }
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(0)}K`;
    }
    return tokens.toString();
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
            <p className="text-gray-400 text-sm">Plan Pro</p>
            <p className="text-white text-xl font-bold">$97 USD / mes</p>
          </div>
        </div>

        {status?.subscriptionStatus === 'trial' && status.trialEndAt && (
          <div className="bg-neon-blue/10 border border-neon-blue/30 rounded-lg p-4 mb-4">
            <p className="text-neon-blue">
              Tu periodo de prueba termina el <strong>{formatDate(status.trialEndAt)}</strong>
            </p>
            <p className="text-neon-blue/70 text-sm mt-1">
              Despues de esta fecha se realizara el primer cobro de $97 USD/mes.
            </p>
          </div>
        )}

        {status?.subscriptionStatus === 'trial' && tokenUsage && (
          <div className="bg-dark-hover rounded-lg p-4 mb-4">
            <div className="flex justify-between items-center mb-2">
              <span className="text-gray-400 text-sm">Uso de tokens este mes</span>
              <span className="text-white text-sm font-medium">
                {formatTokens(tokenUsage.tokensUsed)} / {formatTokens(tokenUsage.tokenLimit)}
              </span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-3 overflow-hidden">
              <div 
                className={`h-3 rounded-full transition-all duration-300 ${
                  tokenUsage.percentUsed >= 100 
                    ? 'bg-accent-error' 
                    : tokenUsage.percentUsed >= 80 
                      ? 'bg-accent-warning' 
                      : 'bg-neon-blue'
                }`}
                style={{ width: `${Math.min(100, tokenUsage.percentUsed)}%` }}
              />
            </div>
            <div className="flex justify-between items-center mt-2">
              <span className="text-gray-500 text-xs">
                {tokenUsage.percentUsed}% usado
              </span>
              {tokenUsage.isOverLimit ? (
                <span className="text-accent-error text-xs font-medium">
                  Limite alcanzado - Suscribete para continuar
                </span>
              ) : tokenUsage.percentUsed >= 80 ? (
                <span className="text-accent-warning text-xs">
                  Cerca del limite
                </span>
              ) : (
                <span className="text-gray-500 text-xs">
                  {formatTokens(tokenUsage.tokensRemaining)} restantes
                </span>
              )}
            </div>
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

        {status?.subscriptionStatus === 'active' && tokenUsage && (
          <div className="bg-dark-hover rounded-lg p-4 mb-4">
            <div className="flex justify-between items-center mb-2">
              <span className="text-gray-400 text-sm">Uso de tokens este mes</span>
              <span className="text-white text-sm font-medium">
                {formatTokens(tokenUsage.tokensUsed)} / {formatTokens(tokenUsage.tokenLimit)}
              </span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-3 overflow-hidden">
              <div 
                className={`h-3 rounded-full transition-all duration-300 ${
                  tokenUsage.percentUsed >= 100 
                    ? 'bg-accent-error' 
                    : tokenUsage.percentUsed >= 80 
                      ? 'bg-accent-warning' 
                      : 'bg-accent-success'
                }`}
                style={{ width: `${Math.min(100, tokenUsage.percentUsed)}%` }}
              />
            </div>
            <div className="flex justify-between items-center mt-2">
              <span className="text-gray-500 text-xs">
                {tokenUsage.percentUsed.toFixed(1)}% usado
              </span>
              {tokenUsage.isOverLimit ? (
                <span className="text-accent-error text-xs font-medium">
                  Limite alcanzado
                </span>
              ) : tokenUsage.percentUsed >= 80 ? (
                <span className="text-accent-warning text-xs">
                  Cerca del limite
                </span>
              ) : (
                <span className="text-gray-500 text-xs">
                  {formatTokens(tokenUsage.tokensRemaining)} restantes
                </span>
              )}
            </div>
            
            {tokenUsage.bonusTokens > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-600">
                <div className="flex justify-between items-center">
                  <span className="text-gray-400 text-sm">Creditos adicionales:</span>
                  <span className="text-accent-success text-sm font-medium">
                    +{formatTokens(tokenUsage.bonusTokens)} tokens
                  </span>
                </div>
              </div>
            )}

            <div className="mt-4 pt-3 border-t border-gray-600">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div>
                  <p className="text-gray-400 text-sm">Necesitas mas tokens?</p>
                  <p className="text-gray-500 text-xs">1 millon de tokens adicionales por $5 USD</p>
                </div>
                <button
                  onClick={handlePurchaseCredits}
                  disabled={creditsLoading}
                  className="btn btn-primary text-sm whitespace-nowrap"
                >
                  {creditsLoading ? 'Procesando...' : 'Comprar 1M tokens por $5'}
                </button>
              </div>
              {creditsMessage && (
                <div className={`mt-3 p-3 rounded-lg ${
                  creditsMessage.type === 'success' 
                    ? 'bg-accent-success/10 border border-accent-success/30 text-accent-success' 
                    : 'bg-accent-error/10 border border-accent-error/30 text-accent-error'
                }`}>
                  {creditsMessage.text}
                </div>
              )}
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
            <>
              <button
                onClick={handleOpenPortal}
                disabled={portalLoading}
                className="btn btn-secondary"
              >
                {portalLoading ? 'Abriendo...' : 'Administrar Facturacion'}
              </button>
              <button
                onClick={handleCancel}
                disabled={actionLoading}
                className="btn btn-danger"
              >
                {actionLoading ? 'Procesando...' : 'Cancelar suscripcion'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6 mb-6">
        <div className="card border-2 border-neon-blue/30">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Plan Pro</h3>
            <span className="bg-neon-blue/20 text-neon-blue px-3 py-1 rounded-full text-sm">Popular</span>
          </div>
          <p className="text-3xl font-bold text-white mb-2">$97 <span className="text-lg text-gray-400 font-normal">USD/mes</span></p>
          <p className="text-gray-400 text-sm mb-4">Ideal para negocios en crecimiento</p>
          <ul className="space-y-2 mb-6">
            {[
              'Conexion WhatsApp ilimitada',
              'Agente IA con 5M tokens/mes',
              'Gestion de productos y catalogo',
              'Seguimientos automaticos',
              'CRM de clientes',
              'Soporte Meta Cloud API'
            ].map((item, i) => (
              <li key={i} className="flex items-center text-gray-300 text-sm">
                <svg className="w-4 h-4 text-accent-success mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                {item}
              </li>
            ))}
          </ul>
          {(status?.subscriptionStatus === 'pending' || status?.subscriptionStatus === 'canceled') && (
            <button onClick={handleSubscribe} disabled={actionLoading} className="btn btn-primary w-full">
              {actionLoading ? 'Procesando...' : 'Comenzar prueba gratis'}
            </button>
          )}
          {(status?.subscriptionStatus === 'trial' || status?.subscriptionStatus === 'active') && (
            <div className="bg-accent-success/10 border border-accent-success/30 rounded-lg p-3 text-center">
              <span className="text-accent-success text-sm font-medium">Plan activo</span>
            </div>
          )}
        </div>

        <div className="card border-2 border-purple-500/30 bg-gradient-to-br from-purple-900/20 to-dark-card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Enterprise Pro</h3>
            <span className="bg-purple-500/20 text-purple-400 px-3 py-1 rounded-full text-sm">Avanzado</span>
          </div>
          <p className="text-3xl font-bold text-white mb-2">$400 <span className="text-lg text-gray-400 font-normal">USD/mes</span></p>
          <p className="text-gray-400 text-sm mb-4">Para empresas con alto volumen</p>
          <ul className="space-y-2 mb-6">
            {[
              'Todo lo del Plan Pro',
              'Agente V2 Enterprise Pro (IA avanzada)',
              'Sistema multi-agente inteligente',
              'Memoria de conversaciones',
              'Aprendizaje automatico de reglas',
              'Tokens ilimitados',
              'Soporte prioritario'
            ].map((item, i) => (
              <li key={i} className="flex items-center text-gray-300 text-sm">
                <svg className="w-4 h-4 text-purple-400 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                {item}
              </li>
            ))}
          </ul>
          <button 
            onClick={() => setShowEnterpriseModal(true)} 
            className="w-full bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            Solicitar Enterprise
          </button>
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

      <HubleFooter variant="full" />

      {showEnterpriseModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-dark-card rounded-xl max-w-lg w-full p-6 border border-gray-700">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-semibold text-white">Solicitar Plan Enterprise</h3>
              <button 
                onClick={() => { setShowEnterpriseModal(false); setEnterpriseMessage(null); }}
                className="text-gray-400 hover:text-white"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="text-gray-400 text-sm mb-6">
              Completa el formulario y nuestro equipo se pondra en contacto contigo para configurar tu plan Enterprise.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-gray-300 text-sm mb-2">Descripcion de tu negocio *</label>
                <textarea
                  value={enterpriseForm.businessDescription}
                  onChange={(e) => setEnterpriseForm({ ...enterpriseForm, businessDescription: e.target.value })}
                  placeholder="Describe brevemente tu negocio y como usas WhatsApp..."
                  rows={3}
                  className="w-full bg-dark-hover border border-gray-600 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-gray-300 text-sm mb-2">Tamano de la empresa</label>
                <select
                  value={enterpriseForm.companySize}
                  onChange={(e) => setEnterpriseForm({ ...enterpriseForm, companySize: e.target.value })}
                  className="w-full bg-dark-hover border border-gray-600 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-purple-500"
                >
                  <option value="">Selecciona una opcion</option>
                  <option value="1-10">1-10 empleados</option>
                  <option value="11-50">11-50 empleados</option>
                  <option value="51-200">51-200 empleados</option>
                  <option value="200+">Mas de 200 empleados</option>
                </select>
              </div>

              <div>
                <label className="block text-gray-300 text-sm mb-2">Caso de uso principal</label>
                <input
                  type="text"
                  value={enterpriseForm.useCase}
                  onChange={(e) => setEnterpriseForm({ ...enterpriseForm, useCase: e.target.value })}
                  placeholder="Ej: Ventas, Soporte al cliente, Reservas..."
                  className="w-full bg-dark-hover border border-gray-600 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                />
              </div>
            </div>

            {enterpriseMessage && (
              <div className={`mt-4 p-3 rounded-lg ${
                enterpriseMessage.type === 'success' 
                  ? 'bg-accent-success/10 border border-accent-success/30 text-accent-success' 
                  : 'bg-accent-error/10 border border-accent-error/30 text-accent-error'
              }`}>
                {enterpriseMessage.text}
              </div>
            )}

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => { setShowEnterpriseModal(false); setEnterpriseMessage(null); }}
                className="flex-1 btn btn-secondary"
              >
                Cancelar
              </button>
              <button
                onClick={handleEnterpriseRequest}
                disabled={enterpriseLoading}
                className="flex-1 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white px-6 py-3 rounded-lg font-medium transition-colors"
              >
                {enterpriseLoading ? 'Enviando...' : 'Enviar Solicitud'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

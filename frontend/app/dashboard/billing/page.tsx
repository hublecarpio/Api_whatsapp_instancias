'use client';

import { useState, useEffect } from 'react';
import { billingApi, authApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import HubleFooter from '@/components/HubleFooter';

interface SubscriptionStatus {
  subscriptionStatus: 'pending' | 'trial' | 'active' | 'past_due' | 'canceled' | 'expired';
  trialEndAt: string | null;
  daysRemaining: number | null;
  isTrialExpired: boolean;
  nextPayment: string | null;
  hasSubscription: boolean;
  proBonusExpiresAt?: string | null;
  hasActiveBonus?: boolean;
  subscriptionTier?: 'BASIC' | 'PRO' | 'ENTERPRISE';
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
  subscriptionTier?: 'BASIC' | 'PRO' | 'ENTERPRISE';
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
  
  // Referral program state
  const [myReferralCode, setMyReferralCode] = useState<{code: string; usageCount: number; commissionRate: number} | null>(null);
  const [referralStats, setReferralStats] = useState<{
    totalReferrals: number;
    activeSubscribers: number;
    totalEarnings: number;
    pendingEarnings: number;
  } | null>(null);
  const [claimLoading, setClaimLoading] = useState(false);
  const [claimMessage, setClaimMessage] = useState<{type: 'success' | 'error', text: string} | null>(null);
  const [customReferralCode, setCustomReferralCode] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [statusRes, tokenRes, meRes] = await Promise.all([
        billingApi.getSubscriptionStatus(),
        billingApi.getTokenUsage(),
        authApi.me()
      ]);
      setStatus(statusRes.data);
      setTokenUsage(tokenRes.data);
      if (meRes.data) {
        updateUser(meRes.data);
      }
      
      // Load referral program data
      try {
        const [codeRes, statsRes] = await Promise.all([
          authApi.getMyReferralCode(),
          authApi.getReferralStats()
        ]);
        if (codeRes.data.hasCode && codeRes.data.code) {
          setMyReferralCode({ 
            code: codeRes.data.code, 
            usageCount: codeRes.data.usageCount || 0,
            commissionRate: codeRes.data.commissionRate ?? 0.10
          });
        }
        setReferralStats(statsRes.data);
      } catch (e) {
        // User may not have a referral code yet
      }
    } catch (error) {
      console.error('Error loading billing data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubscribe = async (plan: 'BASIC' | 'PRO' = 'BASIC') => {
    setActionLoading(true);
    try {
      const res = await billingApi.createCheckoutSession(plan);
      if (res.data.url) {
        window.location.href = res.data.url;
      }
    } catch (error: any) {
      console.error('Error creating checkout session:', error);
      // Handle case where user already has active subscription
      if (error.response?.data?.hasActiveSubscription) {
        alert('Ya tienes una suscripcion activa. Recarga la pagina para ver tu estado actual.');
        loadData(); // Refresh data to show current state
      } else {
        alert('Error al crear la sesion de pago');
      }
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

  const handleUpgrade = async (targetPlan: 'PRO') => {
    if (!confirm(`Deseas actualizar tu plan a ${targetPlan}? Se aplicara un prorrateo por la diferencia de precio.`)) {
      return;
    }
    
    setActionLoading(true);
    try {
      const res = await billingApi.upgradeSubscription(targetPlan);
      if (res.data.success) {
        alert(res.data.message || 'Plan actualizado exitosamente!');
        await loadData();
      }
    } catch (error: any) {
      console.error('Error upgrading subscription:', error);
      alert(error.response?.data?.error || 'Error al actualizar el plan');
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

  const handleClaimReferralCode = async () => {
    const normalizedCode = customReferralCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    
    if (!normalizedCode) {
      setClaimMessage({ type: 'error', text: 'Por favor ingresa un codigo personalizado' });
      return;
    }
    
    if (normalizedCode.length < 4 || normalizedCode.length > 20) {
      setClaimMessage({ type: 'error', text: 'El codigo debe tener entre 4 y 20 caracteres alfanumericos' });
      return;
    }
    
    setClaimLoading(true);
    setClaimMessage(null);
    
    try {
      const response = await authApi.claimReferralCode(normalizedCode);
      setMyReferralCode({ code: response.data.code, usageCount: 0, commissionRate: 0.10 });
      setClaimMessage({ type: 'success', text: 'Tu codigo de referido ha sido creado exitosamente!' });
      setCustomReferralCode('');
      await loadData();
    } catch (error: any) {
      const errorMsg = error.response?.data?.error || 'Error al crear el codigo de referido';
      setClaimMessage({ type: 'error', text: errorMsg });
    } finally {
      setClaimLoading(false);
    }
  };

  const copyReferralLink = () => {
    if (myReferralCode) {
      const link = `${window.location.origin}/register?ref=${myReferralCode.code}`;
      navigator.clipboard.writeText(link);
      setClaimMessage({ type: 'success', text: 'Enlace copiado al portapapeles!' });
      setTimeout(() => setClaimMessage(null), 3000);
    }
  };

  const handlePurchaseCredits = async (tier: number) => {
    // Check if user has active subscription
    if (!status?.hasSubscription || status?.subscriptionStatus !== 'active') {
      setCreditsMessage({ 
        type: 'error', 
        text: 'Necesitas una suscripcion activa para comprar tokens adicionales. Activa tu prueba gratuita primero.' 
      });
      return;
    }

    const tierInfo: Record<number, string> = {
      5: '$5 USD por 300K tokens',
      10: '$10 USD por 600K tokens',
      15: '$15 USD por 1M tokens'
    };
    
    if (!confirm(`Se cobraran ${tierInfo[tier]} adicionales a tu tarjeta guardada. Continuar?`)) {
      return;
    }

    setCreditsLoading(true);
    setCreditsMessage(null);

    try {
      const response = await billingApi.purchaseCredits(tier);
      setCreditsMessage({ type: 'success', text: response.data.message });
      await loadData();
    } catch (error: any) {
      const errorMsg = error.response?.data?.error || 'Error al comprar creditos';
      setCreditsMessage({ type: 'error', text: errorMsg });
    } finally {
      setCreditsLoading(false);
    }
  };

  const isEnterprise = status?.hasActiveBonus || (user?.proBonusExpiresAt && new Date(user.proBonusExpiresAt) > new Date());
  
  // Enterprise takes priority over everything - hide demo/trial when Enterprise is active
  const isDemo = !isEnterprise && ((user as any)?.demoPhase === 'DEMO' || (user as any)?.planType === 'demo');
  const demoInfo = (user as any)?.demoInfo;

  const getStatusBadge = () => {
    if (!status) return null;

    if (isEnterprise) {
      return (
        <span className="bg-purple-600 text-white px-3 py-1 rounded-full text-sm font-medium">
          Avanzado
        </span>
      );
    }

    if (isDemo) {
      return (
        <span className="bg-amber-500 text-white px-3 py-1 rounded-full text-sm font-medium">
          Demo (2 dias)
        </span>
      );
    }

    const badges: Record<string, { color: string; text: string }> = {
      pending: { color: 'bg-gray-500', text: 'Sin suscripcion' },
      trial: { color: 'bg-neon-blue', text: status.daysRemaining !== null ? `Prueba (${status.daysRemaining} dias restantes)` : 'Periodo de prueba' },
      active: { color: 'bg-accent-success', text: 'Activa' },
      past_due: { color: 'bg-accent-warning', text: 'Pago pendiente' },
      canceled: { color: 'bg-accent-error', text: 'Cancelada' },
      expired: { color: 'bg-accent-error', text: 'Prueba expirada' }
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
          {isEnterprise ? (
            <div className="sm:text-right">
              <p className="text-purple-400 text-sm">Plan Enterprise</p>
              <p className="text-white text-xl font-bold">Tokens Ilimitados</p>
            </div>
          ) : tokenUsage?.subscriptionTier === 'PRO' ? (
            <div className="sm:text-right">
              <p className="text-neon-blue text-sm">Plan Pro</p>
              <p className="text-white text-xl font-bold">$97 USD / mes</p>
            </div>
          ) : tokenUsage?.subscriptionTier === 'BASIC' ? (
            <div className="sm:text-right">
              <p className="text-gray-400 text-sm">Plan Basic</p>
              <p className="text-white text-xl font-bold">$29 USD / mes</p>
            </div>
          ) : (
            <div className="sm:text-right">
              <p className="text-gray-400 text-sm">Sin plan activo</p>
              <p className="text-white text-xl font-bold">Elige un plan</p>
            </div>
          )}
        </div>

        {isEnterprise && status?.proBonusExpiresAt && (
          <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-4 mb-4">
            <p className="text-purple-400 font-medium flex items-center gap-2">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              Plan Enterprise Activo
            </p>
            <p className="text-purple-400/70 text-sm mt-1">
              Tu acceso Enterprise es valido hasta el <strong>{formatDate(status.proBonusExpiresAt)}</strong>
            </p>
          </div>
        )}

        {isDemo && (
          <div className={`${demoInfo?.demoExpired ? 'bg-red-500/10 border-red-500/30' : 'bg-amber-500/10 border-amber-500/30'} border rounded-lg p-4 mb-4`}>
            <p className={`${demoInfo?.demoExpired ? 'text-red-400' : 'text-amber-400'} font-medium flex items-center gap-2`}>
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              {demoInfo?.demoExpired ? 'Periodo Demo Expirado' : 'Periodo Demo Activo'}
            </p>
            <p className={`${demoInfo?.demoExpired ? 'text-red-400/70' : 'text-amber-400/70'} text-sm mt-1`}>
              {demoInfo?.demoExpired 
                ? 'Tu periodo de prueba de 2 dias ha terminado. Agrega una tarjeta para continuar usando el agente IA.'
                : `Te quedan ${demoInfo?.daysRemaining || 2} dias de prueba gratis. Limite: 150K tokens.`
              }
            </p>
            {demoInfo?.demoExpired && (
              <p className={`text-red-400/70 text-sm mt-2`}>
                Al suscribirte, obtendras 7 dias de prueba adicionales con 500K tokens y luego el plan de $97 USD/mes.
              </p>
            )}
          </div>
        )}

        {isDemo && tokenUsage && (
          <div className="bg-dark-hover rounded-lg p-4 mb-4">
            <div className="flex justify-between items-center mb-2">
              <span className="text-gray-400 text-sm">Uso de tokens (Demo: 150K max)</span>
              <span className="text-white text-sm font-medium">
                {formatTokens(tokenUsage.tokensUsed)} / 150K
              </span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-3 overflow-hidden">
              <div 
                className={`h-3 rounded-full transition-all duration-300 ${
                  tokenUsage.tokensUsed >= 150000
                    ? 'bg-accent-error' 
                    : tokenUsage.tokensUsed >= 120000
                      ? 'bg-accent-warning' 
                      : 'bg-amber-500'
                }`}
                style={{ width: `${Math.min(100, (tokenUsage.tokensUsed / 150000) * 100)}%` }}
              />
            </div>
            <div className="flex justify-between items-center mt-2">
              <span className="text-gray-500 text-xs">
                {Math.round((tokenUsage.tokensUsed / 150000) * 100)}% usado
              </span>
              {tokenUsage.tokensUsed >= 150000 ? (
                <span className="text-accent-error text-xs font-medium">
                  Limite demo alcanzado - Agrega tarjeta para continuar
                </span>
              ) : (
                <span className="text-gray-500 text-xs">
                  {formatTokens(Math.max(0, 150000 - tokenUsage.tokensUsed))} restantes
                </span>
              )}
            </div>
          </div>
        )}

        {!isEnterprise && !isDemo && status?.subscriptionStatus === 'trial' && status.trialEndAt && (
          <div className="bg-neon-blue/10 border border-neon-blue/30 rounded-lg p-4 mb-4">
            <p className="text-neon-blue">
              Tu periodo de prueba termina el <strong>{formatDate(status.trialEndAt)}</strong>
            </p>
            <p className="text-neon-blue/70 text-sm mt-1">
              Despues de esta fecha se realizara el primer cobro de $97 USD/mes.
            </p>
          </div>
        )}

        {!isEnterprise && !isDemo && status?.subscriptionStatus === 'trial' && tokenUsage && (
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

        {!isEnterprise && status?.subscriptionStatus === 'active' && status.nextPayment && (
          <div className="bg-dark-hover rounded-lg p-4 mb-4">
            <div className="flex justify-between">
              <span className="text-gray-400">Proximo pago:</span>
              <span className="text-white font-medium">{formatDate(status.nextPayment)}</span>
            </div>
          </div>
        )}

        {!isEnterprise && status?.subscriptionStatus === 'active' && tokenUsage && (
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
              <p className="text-gray-400 text-sm mb-3">Recarga tokens adicionales:</p>
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() => handlePurchaseCredits(5)}
                  disabled={creditsLoading}
                  className="bg-dark-card hover:bg-neon-blue/20 border border-gray-600 hover:border-neon-blue/50 rounded-lg p-3 text-center transition-colors disabled:opacity-50"
                >
                  <div className="text-white font-medium">$5</div>
                  <div className="text-gray-400 text-xs">300K tokens</div>
                </button>
                <button
                  onClick={() => handlePurchaseCredits(10)}
                  disabled={creditsLoading}
                  className="bg-dark-card hover:bg-neon-blue/20 border border-gray-600 hover:border-neon-blue/50 rounded-lg p-3 text-center transition-colors disabled:opacity-50"
                >
                  <div className="text-white font-medium">$10</div>
                  <div className="text-gray-400 text-xs">600K tokens</div>
                </button>
                <button
                  onClick={() => handlePurchaseCredits(15)}
                  disabled={creditsLoading}
                  className="bg-dark-card hover:bg-neon-blue/20 border border-gray-600 hover:border-neon-blue/50 rounded-lg p-3 text-center transition-colors disabled:opacity-50"
                >
                  <div className="text-white font-medium">$15</div>
                  <div className="text-gray-400 text-xs">1M tokens</div>
                </button>
              </div>
              {creditsLoading && (
                <p className="text-neon-blue text-xs mt-2 text-center">Procesando compra...</p>
              )}
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

        {status?.subscriptionStatus === 'trial' && status.daysRemaining !== null && status.daysRemaining <= 1 && !status.hasSubscription && (
          <div className="bg-accent-warning/10 border border-accent-warning/30 rounded-lg p-4 mb-4">
            <p className="text-accent-warning font-medium">Tu prueba gratuita esta por expirar</p>
            <p className="text-accent-warning/70 text-sm mt-1">
              Te quedan {status.daysRemaining} {status.daysRemaining === 1 ? 'dia' : 'dias'}. Agrega tu tarjeta ahora para continuar usando el servicio sin interrupciones.
            </p>
          </div>
        )}

        {status?.subscriptionStatus === 'expired' && (
          <div className="bg-accent-error/10 border border-accent-error/30 rounded-lg p-4 mb-4">
            <p className="text-accent-error font-medium">Tu prueba gratuita ha expirado</p>
            <p className="text-accent-error/70 text-sm mt-1">
              Tu periodo de prueba de 2 dias ha terminado. Elige un plan para continuar usando el servicio.
            </p>
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
          {status?.subscriptionStatus === 'past_due' && (
            <button
              onClick={() => handleSubscribe('PRO')}
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

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 md:gap-6 mb-6">
        <div className="card border-2 border-gray-600/30">
          <div className="flex items-center justify-between mb-3 md:mb-4">
            <h3 className="text-base md:text-lg font-semibold text-white">Plan Basic</h3>
            <span className="bg-gray-500/20 text-gray-400 px-2 md:px-3 py-1 rounded-full text-xs md:text-sm">Economico</span>
          </div>
          <p className="text-2xl md:text-3xl font-bold text-white mb-1 md:mb-2">$29 <span className="text-sm md:text-lg text-gray-400 font-normal">USD/mes</span></p>
          <p className="text-gray-400 text-xs md:text-sm mb-3 md:mb-4">Para emprendedores y pequenos negocios</p>
          <ul className="space-y-2 mb-6">
            {[
              'Conexion WhatsApp ilimitada',
              'Agente IA con 1.6M tokens/mes',
              'Gestion de productos y catalogo',
              'Seguimientos automaticos',
              'CRM de clientes',
              'Broadcast masivo',
              'Soporte por email'
            ].map((item, i) => (
              <li key={i} className="flex items-center text-gray-300 text-sm">
                <svg className="w-4 h-4 text-accent-success mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                {item}
              </li>
            ))}
            <li className="flex items-center text-gray-500 text-sm line-through">
              <svg className="w-4 h-4 text-gray-600 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
              Webhooks y API Keys (solo Pro)
            </li>
          </ul>
          {/* Show subscribe button only if no active subscription */}
          {!status?.hasSubscription && (status?.subscriptionStatus === 'pending' || status?.subscriptionStatus === 'canceled' || status?.subscriptionStatus === 'expired' || status?.subscriptionStatus === 'trial') && (
            <button onClick={() => handleSubscribe('BASIC')} disabled={actionLoading} className="btn btn-secondary w-full">
              {actionLoading ? 'Procesando...' : status?.subscriptionStatus === 'trial' ? 'Activar con tarjeta (5 dias gratis)' : 'Comenzar con Basic'}
            </button>
          )}
          {/* Show active badge if user has BASIC subscription */}
          {status?.hasSubscription && (status?.subscriptionTier === 'BASIC' || tokenUsage?.subscriptionTier === 'BASIC') && (
            <div className="bg-accent-success/10 border border-accent-success/30 rounded-lg p-3 text-center">
              <span className="text-accent-success text-sm font-medium">Plan activo</span>
            </div>
          )}
        </div>

        <div className="card border-2 border-neon-blue/30">
          <div className="flex items-center justify-between mb-3 md:mb-4">
            <h3 className="text-base md:text-lg font-semibold text-white">Plan Pro</h3>
            <span className="bg-neon-blue/20 text-neon-blue px-2 md:px-3 py-1 rounded-full text-xs md:text-sm">Recomendado</span>
          </div>
          <p className="text-2xl md:text-3xl font-bold text-white mb-1 md:mb-2">$97 <span className="text-sm md:text-lg text-gray-400 font-normal">USD/mes</span></p>
          <p className="text-gray-400 text-xs md:text-sm mb-3 md:mb-4">Para negocios en crecimiento</p>
          <ul className="space-y-2 mb-6">
            {[
              'Todo lo del plan Basic',
              'Agente IA con 7.5M tokens/mes',
              'Tools personalizadas (APIs externas)',
              'Webhooks personalizados',
              'API Keys para integraciones',
              'Soporte prioritario'
            ].map((item, i) => (
              <li key={i} className="flex items-center text-gray-300 text-sm">
                <svg className="w-4 h-4 text-accent-success mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                {item}
              </li>
            ))}
          </ul>
          {/* Show subscribe/upgrade button only if no subscription OR has BASIC and wants to upgrade */}
          {!status?.hasSubscription && (status?.subscriptionStatus === 'pending' || status?.subscriptionStatus === 'canceled' || status?.subscriptionStatus === 'expired' || status?.subscriptionStatus === 'trial') && (
            <button onClick={() => handleSubscribe('PRO')} disabled={actionLoading} className="btn btn-primary w-full">
              {actionLoading ? 'Procesando...' : status?.subscriptionStatus === 'trial' ? 'Activar Pro (5 dias gratis)' : 'Comenzar con Pro'}
            </button>
          )}
          {/* Show upgrade button for BASIC users */}
          {status?.hasSubscription && (status?.subscriptionTier === 'BASIC' || tokenUsage?.subscriptionTier === 'BASIC') && (
            <button onClick={() => handleUpgrade('PRO')} disabled={actionLoading} className="btn btn-primary w-full">
              {actionLoading ? 'Procesando...' : 'Upgrade a Pro'}
            </button>
          )}
          {/* Show active badge if user has PRO subscription */}
          {status?.hasSubscription && (status?.subscriptionTier === 'PRO' || tokenUsage?.subscriptionTier === 'PRO') && (
            <div className="bg-accent-success/10 border border-accent-success/30 rounded-lg p-3 text-center">
              <span className="text-accent-success text-sm font-medium">Plan activo</span>
            </div>
          )}
        </div>

        <div className="card border-2 border-purple-500/30 bg-gradient-to-br from-purple-900/20 to-dark-card">
          <div className="flex items-center justify-between mb-3 md:mb-4">
            <h3 className="text-base md:text-lg font-semibold text-white">Enterprise Pro</h3>
            <span className="bg-purple-500/20 text-purple-400 px-2 md:px-3 py-1 rounded-full text-xs md:text-sm">Avanzado</span>
          </div>
          <p className="text-2xl md:text-3xl font-bold text-white mb-1 md:mb-2">$400 <span className="text-sm md:text-lg text-gray-400 font-normal">USD/mes</span></p>
          <p className="text-gray-400 text-xs md:text-sm mb-3 md:mb-4">Para empresas con alto volumen</p>
          <ul className="space-y-2 mb-6">
            {[
              'Todo lo del Plan Pro',
              'Agente V2 Enterprise (IA avanzada)',
              'Sistema multi-agente inteligente',
              'RAG contextual para mayor contexto',
              'Aprendizaje automatico de reglas',
              'Tokens ilimitados',
              'Soporte dedicado'
            ].map((item, i) => (
              <li key={i} className="flex items-center text-gray-300 text-sm">
                <svg className="w-4 h-4 text-purple-400 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                {item}
              </li>
            ))}
          </ul>
          {isEnterprise ? (
            <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-3 text-center">
              <span className="text-purple-400 text-sm font-medium">Plan activo</span>
            </div>
          ) : (
            <button 
              onClick={() => setShowEnterpriseModal(true)} 
              className="w-full bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-medium transition-colors"
            >
              Solicitar Enterprise
            </button>
          )}
        </div>
      </div>

      {/* Programa de Beneficios - User's own referral program */}
      <div className="card mb-6 border-2 border-accent-success/30 bg-gradient-to-br from-accent-success/5 to-dark-card">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-accent-success/20 rounded-full flex items-center justify-center">
            <svg className="w-5 h-5 text-accent-success" fill="currentColor" viewBox="0 0 20 20">
              <path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v3h8v-3zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-3a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v3h-3zM4.75 12.094A5.973 5.973 0 004 15v3H1v-3a3 3 0 013.75-2.906z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Programa de Beneficios</h2>
            <p className="text-accent-success text-sm">Gana el {myReferralCode ? Math.round(myReferralCode.commissionRate * 100) : 10}% de comision por cada referido</p>
          </div>
        </div>
        
        <p className="text-gray-400 text-sm mb-4">
          Comparte tu codigo y gana el {myReferralCode ? Math.round(myReferralCode.commissionRate * 100) : 10}% de cada pago que realicen tus referidos. 
          Ademas, tus referidos reciben 3 dias extra de demo y 7 dias extra de prueba gratis.
        </p>

        {!myReferralCode ? (
          <div className="bg-dark-hover rounded-lg p-4">
            <p className="text-gray-300 text-sm mb-3">
              Aun no tienes un codigo de referido. Elige un codigo personalizado para empezar a ganar comisiones.
            </p>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={customReferralCode}
                onChange={(e) => setCustomReferralCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                placeholder="Ej: MICODIGO2024"
                maxLength={20}
                className="flex-1 bg-dark-card border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:border-accent-success focus:outline-none"
              />
              <button
                onClick={handleClaimReferralCode}
                disabled={claimLoading || !customReferralCode.trim()}
                className="btn btn-primary"
              >
                {claimLoading ? 'Creando...' : 'Crear codigo'}
              </button>
            </div>
            <p className="text-gray-500 text-xs">4-20 caracteres alfanumericos. Solo letras y numeros.</p>
            {claimMessage && (
              <p className={`mt-2 text-sm ${claimMessage.type === 'success' ? 'text-accent-success' : 'text-red-400'}`}>
                {claimMessage.text}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-dark-hover rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-gray-400 text-sm">Tu codigo:</span>
                <span className="text-white font-mono text-lg font-bold">{myReferralCode.code}</span>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={`${typeof window !== 'undefined' ? window.location.origin : ''}/register?ref=${myReferralCode.code}`}
                  className="flex-1 bg-dark-card border border-gray-600 rounded-lg px-3 py-2 text-gray-300 text-sm"
                />
                <button
                  onClick={copyReferralLink}
                  className="btn btn-secondary text-sm px-4"
                >
                  Copiar
                </button>
              </div>
            </div>

            {referralStats && (
              <div className="grid grid-cols-2 gap-2 md:gap-3">
                <div className="bg-dark-hover rounded-lg p-2 md:p-3 text-center">
                  <div className="text-xl md:text-2xl font-bold text-white">{referralStats.totalReferrals || 0}</div>
                  <div className="text-gray-400 text-xs">Referidos</div>
                </div>
                <div className="bg-dark-hover rounded-lg p-2 md:p-3 text-center">
                  <div className="text-xl md:text-2xl font-bold text-accent-success">{referralStats.activeSubscribers || 0}</div>
                  <div className="text-gray-400 text-xs">Activos</div>
                </div>
                <div className="bg-dark-hover rounded-lg p-2 md:p-3 text-center">
                  <div className="text-xl md:text-2xl font-bold text-accent-warning">${(referralStats.pendingEarnings || 0).toFixed(2)}</div>
                  <div className="text-gray-400 text-xs">Pendiente</div>
                </div>
                <div className="bg-dark-hover rounded-lg p-2 md:p-3 text-center">
                  <div className="text-xl md:text-2xl font-bold text-neon-blue">${(referralStats.totalEarnings || 0).toFixed(2)}</div>
                  <div className="text-gray-400 text-xs">Total ganado</div>
                </div>
              </div>
            )}

            <div className="bg-accent-success/10 border border-accent-success/30 rounded-lg p-3 space-y-2">
              <p className="text-accent-success text-sm">
                <strong>Como funciona:</strong> Por cada referido que se suscriba, recibiras el {myReferralCode ? Math.round(myReferralCode.commissionRate * 100) : 10}% de su pago mensual 
                (${(97 * (myReferralCode?.commissionRate ?? 0.10)).toFixed(2)} USD por suscriptor PRO activo). Los pagos se procesan el dia 1 de cada mes.
              </p>
              <p className="text-accent-success/80 text-xs">
                <strong>Metodos de pago:</strong> USDT (via Lemon) o PayPal. Contactanos para configurar tu metodo preferido.
              </p>
            </div>
          </div>
        )}

        {claimMessage && (
          <div className={`mt-3 p-3 rounded-lg ${
            claimMessage.type === 'success' 
              ? 'bg-accent-success/10 border border-accent-success/30 text-accent-success' 
              : 'bg-accent-error/10 border border-accent-error/30 text-accent-error'
          }`}>
            {claimMessage.text}
          </div>
        )}
      </div>

      <div className="card mb-6">
        <h2 className="text-lg font-semibold text-white mb-2">Codigo de Referido</h2>
        <p className="text-gray-400 text-sm mb-4">
          Si tienes un codigo de referido, ingresalo aqui para obtener dias de prueba Pro gratis.
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

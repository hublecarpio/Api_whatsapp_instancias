'use client';

import { useState, useEffect } from 'react';

interface DashboardKPIs {
  users: { total: number; today: number; thisMonth: number; active: number; trial: number; suspended: number };
  businesses: { total: number; withWhatsApp: number };
  whatsapp: { total: number; connected: number; disconnected: number; healthPercent: number };
  contacts: { total: number; today: number };
  orders: { total: number; thisMonth: number };
  appointments: { total: number; thisMonth: number };
  tokens: { today: { tokens: number; cost: number }; thisMonth: { tokens: number; cost: number } };
  messaging: { last7Days: number };
  reminders: { active: number; failed: number };
  broadcasts: { thisMonth: number };
  revenue: { mrr: number; subscriptionsByTier: Record<string, number> };
}

interface SearchResult {
  type: string;
  id: string;
  label: string;
  sublabel?: string;
  meta: Record<string, any>;
}

interface FunnelStep {
  stage: string;
  count: number;
  percent: number;
}

interface TenantDetails {
  user: {
    id: string;
    email: string;
    name: string;
    phone: string;
    emailVerified: boolean;
    subscriptionStatus: string;
    subscriptionTier: string;
    trialEndAt: string;
    stripeCustomerId: string;
    createdAt: string;
  };
  businesses: Array<{
    id: string;
    name: string;
    objective: string;
    onboardingCompleted: boolean;
    instances: Array<{ id: string; phoneNumber: string; status: string; provider: string; lastConnection: string }>;
    counts: { contacts: number; orders: number; appointments: number; reminders: number };
  }>;
  usage: { totalTokens: number; totalCost: number; messagesLast7Days: number };
}

interface WhatsAppHealth {
  summary: { total: number; healthy: number; unhealthy: number; byStatus: Record<string, number>; byProvider: Record<string, number> };
  instances: Array<any>;
  needsAttention: Array<any>;
}

interface TokenAnalytics {
  byFeature: Array<{ feature: string; tokens: number; cost: number; count: number }>;
  byProvider: Array<{ provider: string; tokens: number; cost: number; count: number }>;
  byModel: Array<{ model: string; tokens: number; cost: number; count: number }>;
  topUsers: Array<{ userId: string; email: string; name: string; tier: string; tokens: number; cost: number }>;
}

interface RevenueAnalytics {
  revenue: { mrr: number; arr: number };
  subscriptions: { byTier: Record<string, number>; byStatus: Record<string, number> };
  trials: { endingSoon: number };
  referrals: { topCodes: Array<any> };
}

export default function SuperAdminV2({ token }: { token: string }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [kpis, setKpis] = useState<DashboardKPIs | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [funnel, setFunnel] = useState<FunnelStep[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<TenantDetails | null>(null);
  const [waHealth, setWaHealth] = useState<WhatsAppHealth | null>(null);
  const [tokenAnalytics, setTokenAnalytics] = useState<TokenAnalytics | null>(null);
  const [revenueAnalytics, setRevenueAnalytics] = useState<RevenueAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchKPIs();
    const interval = setInterval(fetchKPIs, 30000);
    return () => clearInterval(interval);
  }, [token]);

  useEffect(() => {
    if (activeTab === 'tenants') fetchFunnel();
    if (activeTab === 'whatsapp') fetchWAHealth();
    if (activeTab === 'tokens') fetchTokenAnalytics();
    if (activeTab === 'revenue') fetchRevenueAnalytics();
  }, [activeTab]);

  const fetchKPIs = async () => {
    try {
      const res = await fetch('/api/super-admin/v2/dashboard-kpis', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setKpis(data);
      }
    } catch (err) {
      console.error('Failed to fetch KPIs:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchFunnel = async () => {
    try {
      const res = await fetch('/api/super-admin/v2/conversion-funnel', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setFunnel(data.funnel);
      }
    } catch (err) {
      console.error('Failed to fetch funnel:', err);
    }
  };

  const fetchWAHealth = async () => {
    try {
      const res = await fetch('/api/super-admin/v2/whatsapp-health', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setWaHealth(data);
      }
    } catch (err) {
      console.error('Failed to fetch WA health:', err);
    }
  };

  const fetchTokenAnalytics = async () => {
    try {
      const res = await fetch('/api/super-admin/v2/token-analytics', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setTokenAnalytics(data);
      }
    } catch (err) {
      console.error('Failed to fetch token analytics:', err);
    }
  };

  const fetchRevenueAnalytics = async () => {
    try {
      const res = await fetch('/api/super-admin/v2/revenue-analytics', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setRevenueAnalytics(data);
      }
    } catch (err) {
      console.error('Failed to fetch revenue analytics:', err);
    }
  };

  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`/api/super-admin/v2/global-search?q=${encodeURIComponent(query)}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.results);
      }
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setSearching(false);
    }
  };

  const fetchTenantDetails = async (userId: string) => {
    try {
      const res = await fetch(`/api/super-admin/v2/tenant-details/${userId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setSelectedTenant(data);
      }
    } catch (err) {
      console.error('Failed to fetch tenant details:', err);
    }
  };

  const tabs = [
    { id: 'overview', label: 'Vista General', icon: '📊' },
    { id: 'tenants', label: 'Tenants', icon: '👥' },
    { id: 'whatsapp', label: 'WhatsApp', icon: '📱' },
    { id: 'tokens', label: 'AI & Tokens', icon: '🤖' },
    { id: 'revenue', label: 'Revenue', icon: '💰' }
  ];

  const formatNumber = (n: number) => n?.toLocaleString() || '0';
  const formatCurrency = (n: number) => `$${(n || 0).toFixed(2)}`;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-neon-blue"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row gap-4 items-start lg:items-center justify-between">
        <div className="relative flex-1 max-w-xl">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Buscar usuarios, negocios, contactos, instancias..."
            className="input w-full pl-10"
          />
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          {searching && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-neon-blue"></div>
            </div>
          )}
          {searchResults.length > 0 && searchQuery.length >= 2 && (
            <div className="absolute top-full left-0 right-0 mt-2 bg-dark-surface border border-dark-border rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto">
              {searchResults.map((result, i) => (
                <button
                  key={`${result.type}-${result.id}-${i}`}
                  onClick={() => {
                    if (result.type === 'user') {
                      fetchTenantDetails(result.id);
                      setActiveTab('tenants');
                    }
                    setSearchQuery('');
                    setSearchResults([]);
                  }}
                  className="w-full px-4 py-3 flex items-center gap-3 hover:bg-dark-hover transition-colors border-b border-dark-border/50 last:border-0"
                >
                  <span className="text-lg">
                    {result.type === 'user' ? '👤' : result.type === 'business' ? '🏢' : result.type === 'contact' ? '📞' : '📱'}
                  </span>
                  <div className="flex-1 text-left">
                    <div className="text-white text-sm font-medium">{result.label}</div>
                    {result.sublabel && <div className="text-gray-400 text-xs">{result.sublabel}</div>}
                  </div>
                  <span className="text-xs px-2 py-1 bg-dark-hover rounded text-gray-400 capitalize">{result.type}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-2 bg-dark-surface/50 p-1 rounded-lg">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
                activeTab === tab.id
                  ? 'bg-neon-blue text-white shadow-lg shadow-neon-blue/20'
                  : 'text-gray-400 hover:text-white hover:bg-dark-hover'
              }`}
            >
              <span>{tab.icon}</span>
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'overview' && kpis && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
            <KPICard title="Usuarios" value={formatNumber(kpis.users.total)} subtitle={`+${kpis.users.today} hoy`} color="blue" />
            <KPICard title="Activos" value={formatNumber(kpis.users.active)} subtitle={`${kpis.users.trial} en trial`} color="green" />
            <KPICard title="WhatsApp" value={`${kpis.whatsapp.healthPercent}%`} subtitle={`${kpis.whatsapp.connected}/${kpis.whatsapp.total}`} color={kpis.whatsapp.healthPercent > 80 ? 'green' : kpis.whatsapp.healthPercent > 50 ? 'yellow' : 'red'} />
            <KPICard title="Contactos" value={formatNumber(kpis.contacts.total)} subtitle={`+${kpis.contacts.today} hoy`} color="purple" />
            <KPICard title="MRR" value={formatCurrency(kpis.revenue.mrr)} subtitle="mensual" color="green" />
            <KPICard title="Tokens Hoy" value={formatNumber(kpis.tokens.today.tokens)} subtitle={formatCurrency(kpis.tokens.today.cost)} color="orange" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Suscripciones por Tier</h3>
              <div className="space-y-3">
                {Object.entries(kpis.revenue.subscriptionsByTier).map(([tier, count]) => (
                  <div key={tier} className="flex items-center gap-4">
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                      tier === 'PRO' ? 'bg-purple-500/20 text-purple-400' :
                      tier === 'BASIC' ? 'bg-blue-500/20 text-blue-400' :
                      tier === 'ENTERPRISE' ? 'bg-amber-500/20 text-amber-400' :
                      'bg-gray-500/20 text-gray-400'
                    }`}>{tier}</span>
                    <div className="flex-1 h-2 bg-dark-hover rounded-full overflow-hidden">
                      <div 
                        className={`h-full ${
                          tier === 'PRO' ? 'bg-purple-500' :
                          tier === 'BASIC' ? 'bg-blue-500' :
                          tier === 'ENTERPRISE' ? 'bg-amber-500' :
                          'bg-gray-500'
                        }`}
                        style={{ width: `${(count / kpis.users.active) * 100}%` }}
                      />
                    </div>
                    <span className="text-white font-medium w-12 text-right">{count}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Actividad Reciente</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-dark-hover/50 rounded-lg p-4">
                  <div className="text-2xl font-bold text-white">{formatNumber(kpis.messaging.last7Days)}</div>
                  <div className="text-gray-400 text-sm">Mensajes (7 dias)</div>
                </div>
                <div className="bg-dark-hover/50 rounded-lg p-4">
                  <div className="text-2xl font-bold text-white">{formatNumber(kpis.orders.thisMonth)}</div>
                  <div className="text-gray-400 text-sm">Ordenes (mes)</div>
                </div>
                <div className="bg-dark-hover/50 rounded-lg p-4">
                  <div className="text-2xl font-bold text-white">{formatNumber(kpis.appointments.thisMonth)}</div>
                  <div className="text-gray-400 text-sm">Citas (mes)</div>
                </div>
                <div className="bg-dark-hover/50 rounded-lg p-4">
                  <div className="text-2xl font-bold text-white">{formatNumber(kpis.broadcasts.thisMonth)}</div>
                  <div className="text-gray-400 text-sm">Broadcasts (mes)</div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Reminders</h3>
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <div className="text-3xl font-bold text-green-400">{formatNumber(kpis.reminders.active)}</div>
                  <div className="text-gray-400 text-sm">Activos</div>
                </div>
                <div className="flex-1">
                  <div className="text-3xl font-bold text-red-400">{formatNumber(kpis.reminders.failed)}</div>
                  <div className="text-gray-400 text-sm">Fallidos</div>
                </div>
              </div>
            </div>

            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Tokens Este Mes</h3>
              <div className="text-3xl font-bold text-orange-400">{formatNumber(kpis.tokens.thisMonth.tokens)}</div>
              <div className="text-gray-400 text-sm">Costo: {formatCurrency(kpis.tokens.thisMonth.cost)}</div>
            </div>

            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Usuarios Suspendidos</h3>
              <div className="text-3xl font-bold text-red-400">{formatNumber(kpis.users.suspended)}</div>
              <div className="text-gray-400 text-sm">Requieren atencion</div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'tenants' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 card">
            <h3 className="text-lg font-semibold text-white mb-4">Funnel de Conversion</h3>
            <div className="space-y-3">
              {funnel.map((step, i) => (
                <div key={step.stage} className="relative">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-gray-300">{step.stage}</span>
                    <span className="text-sm font-medium text-white">{step.count} ({step.percent}%)</span>
                  </div>
                  <div className="h-2 bg-dark-hover rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-gradient-to-r from-neon-blue to-purple-500 transition-all"
                      style={{ width: `${step.percent}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-2">
            {selectedTenant ? (
              <div className="card">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-lg font-semibold text-white">Detalles del Tenant</h3>
                  <button onClick={() => setSelectedTenant(null)} className="text-gray-400 hover:text-white">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                
                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div>
                    <div className="text-gray-400 text-sm">Email</div>
                    <div className="text-white font-medium">{selectedTenant.user.email}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-sm">Estado</div>
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      selectedTenant.user.subscriptionStatus === 'ACTIVE' ? 'bg-green-500/20 text-green-400' :
                      selectedTenant.user.subscriptionStatus === 'TRIAL' ? 'bg-blue-500/20 text-blue-400' :
                      selectedTenant.user.subscriptionStatus === 'DEMO' ? 'bg-yellow-500/20 text-yellow-400' :
                      'bg-red-500/20 text-red-400'
                    }`}>{selectedTenant.user.subscriptionStatus}</span>
                  </div>
                  <div>
                    <div className="text-gray-400 text-sm">Tier</div>
                    <div className="text-white font-medium">{selectedTenant.user.subscriptionTier || 'N/A'}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-sm">Creado</div>
                    <div className="text-white font-medium">{new Date(selectedTenant.user.createdAt).toLocaleDateString()}</div>
                  </div>
                </div>

                <div className="border-t border-dark-border pt-4 mb-4">
                  <h4 className="text-white font-medium mb-3">Uso</h4>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="bg-dark-hover/50 rounded-lg p-3 text-center">
                      <div className="text-xl font-bold text-white">{formatNumber(selectedTenant.usage.totalTokens)}</div>
                      <div className="text-gray-400 text-xs">Tokens</div>
                    </div>
                    <div className="bg-dark-hover/50 rounded-lg p-3 text-center">
                      <div className="text-xl font-bold text-white">{formatCurrency(selectedTenant.usage.totalCost)}</div>
                      <div className="text-gray-400 text-xs">Costo</div>
                    </div>
                    <div className="bg-dark-hover/50 rounded-lg p-3 text-center">
                      <div className="text-xl font-bold text-white">{selectedTenant.usage.messagesLast7Days}</div>
                      <div className="text-gray-400 text-xs">Msgs (7d)</div>
                    </div>
                  </div>
                </div>

                <div className="border-t border-dark-border pt-4">
                  <h4 className="text-white font-medium mb-3">Negocios ({selectedTenant.businesses.length})</h4>
                  <div className="space-y-3">
                    {selectedTenant.businesses.map(biz => (
                      <div key={biz.id} className="bg-dark-hover/30 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-white font-medium">{biz.name}</span>
                          <span className={`px-2 py-0.5 rounded text-xs ${biz.onboardingCompleted ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
                            {biz.onboardingCompleted ? 'Activo' : 'Onboarding'}
                          </span>
                        </div>
                        <div className="flex gap-4 text-xs text-gray-400">
                          <span>{biz.counts.contacts} contactos</span>
                          <span>{biz.counts.orders} ordenes</span>
                          <span>{biz.counts.appointments} citas</span>
                        </div>
                        {biz.instances.length > 0 && (
                          <div className="mt-2 flex gap-2">
                            {biz.instances.map(inst => (
                              <span key={inst.id} className={`px-2 py-1 rounded text-xs ${
                                ['open', 'connected'].includes(inst.status) ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                              }`}>
                                {inst.phoneNumber || inst.provider}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="card flex items-center justify-center h-64 text-gray-400">
                <div className="text-center">
                  <svg className="w-12 h-12 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <p>Busca un usuario para ver sus detalles</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'whatsapp' && waHealth && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KPICard title="Total" value={formatNumber(waHealth.summary.total)} color="blue" />
            <KPICard title="Saludables" value={formatNumber(waHealth.summary.healthy)} color="green" />
            <KPICard title="Requieren Atencion" value={formatNumber(waHealth.summary.unhealthy)} color="red" />
            <KPICard 
              title="Salud" 
              value={`${waHealth.summary.total > 0 ? Math.round((waHealth.summary.healthy / waHealth.summary.total) * 100) : 0}%`} 
              color={waHealth.summary.healthy / waHealth.summary.total > 0.8 ? 'green' : 'yellow'} 
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Por Estado</h3>
              <div className="space-y-2">
                {Object.entries(waHealth.summary.byStatus).map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between py-2 border-b border-dark-border/50 last:border-0">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      ['open', 'connected'].includes(status) ? 'bg-green-500/20 text-green-400' :
                      status === 'requires_qr' ? 'bg-yellow-500/20 text-yellow-400' :
                      'bg-red-500/20 text-red-400'
                    }`}>{status}</span>
                    <span className="text-white font-medium">{count}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Por Provider</h3>
              <div className="space-y-2">
                {Object.entries(waHealth.summary.byProvider).map(([provider, count]) => (
                  <div key={provider} className="flex items-center justify-between py-2 border-b border-dark-border/50 last:border-0">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      provider === 'META_CLOUD' ? 'bg-blue-500/20 text-blue-400' : 'bg-green-500/20 text-green-400'
                    }`}>{provider}</span>
                    <span className="text-white font-medium">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {waHealth.needsAttention.length > 0 && (
            <div className="card border-red-500/30">
              <h3 className="text-lg font-semibold text-red-400 mb-4">Requieren Atencion ({waHealth.needsAttention.length})</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-400 border-b border-dark-border">
                      <th className="text-left py-2 px-3">Telefono</th>
                      <th className="text-left py-2 px-3">Negocio</th>
                      <th className="text-left py-2 px-3">Usuario</th>
                      <th className="text-left py-2 px-3">Estado</th>
                      <th className="text-left py-2 px-3">Ultima Conexion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {waHealth.needsAttention.slice(0, 10).map((inst, i) => (
                      <tr key={i} className="border-b border-dark-border/50 hover:bg-dark-hover/50">
                        <td className="py-2 px-3 text-white">{inst.phoneNumber || '-'}</td>
                        <td className="py-2 px-3 text-gray-300">{inst.businessName || '-'}</td>
                        <td className="py-2 px-3 text-gray-300">{inst.userEmail || '-'}</td>
                        <td className="py-2 px-3">
                          <span className="px-2 py-0.5 rounded text-xs bg-red-500/20 text-red-400">{inst.status}</span>
                        </td>
                        <td className="py-2 px-3 text-gray-400">{inst.lastConnection ? new Date(inst.lastConnection).toLocaleString() : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'tokens' && tokenAnalytics && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Por Feature</h3>
              <div className="space-y-3">
                {tokenAnalytics.byFeature.slice(0, 8).map(f => (
                  <div key={f.feature} className="flex items-center justify-between">
                    <span className="text-gray-300 text-sm truncate">{f.feature}</span>
                    <div className="text-right">
                      <div className="text-white font-medium">{formatNumber(f.tokens)}</div>
                      <div className="text-gray-400 text-xs">{formatCurrency(f.cost)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Por Modelo</h3>
              <div className="space-y-3">
                {tokenAnalytics.byModel.slice(0, 8).map(m => (
                  <div key={m.model} className="flex items-center justify-between">
                    <span className="text-gray-300 text-sm truncate">{m.model}</span>
                    <div className="text-right">
                      <div className="text-white font-medium">{formatNumber(m.tokens)}</div>
                      <div className="text-gray-400 text-xs">{formatCurrency(m.cost)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Por Provider</h3>
              <div className="space-y-3">
                {tokenAnalytics.byProvider.map(p => (
                  <div key={p.provider} className="flex items-center justify-between">
                    <span className={`px-2 py-1 rounded text-xs ${
                      p.provider === 'openai' ? 'bg-green-500/20 text-green-400' :
                      p.provider === 'gemini' ? 'bg-blue-500/20 text-blue-400' :
                      'bg-gray-500/20 text-gray-400'
                    }`}>{p.provider}</span>
                    <div className="text-right">
                      <div className="text-white font-medium">{formatNumber(p.tokens)}</div>
                      <div className="text-gray-400 text-xs">{formatCurrency(p.cost)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <h3 className="text-lg font-semibold text-white mb-4">Top 10 Usuarios por Consumo (30 dias)</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-dark-border">
                    <th className="text-left py-2 px-3">#</th>
                    <th className="text-left py-2 px-3">Email</th>
                    <th className="text-left py-2 px-3">Tier</th>
                    <th className="text-right py-2 px-3">Tokens</th>
                    <th className="text-right py-2 px-3">Costo</th>
                  </tr>
                </thead>
                <tbody>
                  {tokenAnalytics.topUsers.map((user, i) => (
                    <tr key={user.userId} className="border-b border-dark-border/50 hover:bg-dark-hover/50">
                      <td className="py-2 px-3 text-gray-400">{i + 1}</td>
                      <td className="py-2 px-3 text-white">{user.email}</td>
                      <td className="py-2 px-3">
                        <span className={`px-2 py-0.5 rounded text-xs ${
                          user.tier === 'PRO' ? 'bg-purple-500/20 text-purple-400' :
                          user.tier === 'BASIC' ? 'bg-blue-500/20 text-blue-400' :
                          'bg-gray-500/20 text-gray-400'
                        }`}>{user.tier || 'N/A'}</span>
                      </td>
                      <td className="py-2 px-3 text-right text-white font-medium">{formatNumber(user.tokens)}</td>
                      <td className="py-2 px-3 text-right text-orange-400">{formatCurrency(user.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'revenue' && revenueAnalytics && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KPICard title="MRR" value={formatCurrency(revenueAnalytics.revenue.mrr)} color="green" />
            <KPICard title="ARR" value={formatCurrency(revenueAnalytics.revenue.arr)} color="green" />
            <KPICard title="Trials Expirando" value={formatNumber(revenueAnalytics.trials.endingSoon)} subtitle="proximos 3 dias" color="yellow" />
            <KPICard title="Activos" value={formatNumber(revenueAnalytics.subscriptions.byStatus['ACTIVE'] || 0)} color="blue" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Suscripciones por Tier</h3>
              <div className="space-y-4">
                {Object.entries(revenueAnalytics.subscriptions.byTier).map(([tier, count]) => {
                  const prices: Record<string, number> = { 'BASIC': 29, 'PRO': 97, 'ENTERPRISE': 197 };
                  const revenue = (prices[tier] || 0) * count;
                  return (
                    <div key={tier} className="bg-dark-hover/30 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                          tier === 'PRO' ? 'bg-purple-500/20 text-purple-400' :
                          tier === 'BASIC' ? 'bg-blue-500/20 text-blue-400' :
                          tier === 'ENTERPRISE' ? 'bg-amber-500/20 text-amber-400' :
                          'bg-gray-500/20 text-gray-400'
                        }`}>{tier}</span>
                        <span className="text-green-400 font-bold">{formatCurrency(revenue)}/mes</span>
                      </div>
                      <div className="text-gray-400 text-sm">{count} suscriptores x ${prices[tier] || 0}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Estado de Usuarios</h3>
              <div className="space-y-3">
                {Object.entries(revenueAnalytics.subscriptions.byStatus).map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between py-2 border-b border-dark-border/50 last:border-0">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      status === 'ACTIVE' ? 'bg-green-500/20 text-green-400' :
                      status === 'TRIAL' ? 'bg-blue-500/20 text-blue-400' :
                      status === 'DEMO' ? 'bg-yellow-500/20 text-yellow-400' :
                      status === 'SUSPENDED' ? 'bg-red-500/20 text-red-400' :
                      'bg-gray-500/20 text-gray-400'
                    }`}>{status}</span>
                    <span className="text-white font-medium">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {revenueAnalytics.referrals.topCodes.length > 0 && (
            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Top Codigos de Referido</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-400 border-b border-dark-border">
                      <th className="text-left py-2 px-3">Codigo</th>
                      <th className="text-right py-2 px-3">Usos</th>
                      <th className="text-right py-2 px-3">Bonus Demo</th>
                      <th className="text-right py-2 px-3">Comision</th>
                      <th className="text-center py-2 px-3">Afiliado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {revenueAnalytics.referrals.topCodes.map((code: any) => (
                      <tr key={code.id} className="border-b border-dark-border/50 hover:bg-dark-hover/50">
                        <td className="py-2 px-3 text-white font-mono">{code.code}</td>
                        <td className="py-2 px-3 text-right text-white">{code.usageCount}</td>
                        <td className="py-2 px-3 text-right text-gray-300">{code.bonusDemoDays || 0} dias</td>
                        <td className="py-2 px-3 text-right text-green-400">{(code.commissionRate || 0) * 100}%</td>
                        <td className="py-2 px-3 text-center">
                          {code.isAffiliate ? (
                            <span className="text-green-400">Si</span>
                          ) : (
                            <span className="text-gray-400">No</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KPICard({ title, value, subtitle, color }: { title: string; value: string; subtitle?: string; color: 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'orange' }) {
  const colorClasses = {
    blue: 'from-blue-500/20 to-transparent border-blue-500/30 text-blue-400',
    green: 'from-green-500/20 to-transparent border-green-500/30 text-green-400',
    yellow: 'from-yellow-500/20 to-transparent border-yellow-500/30 text-yellow-400',
    red: 'from-red-500/20 to-transparent border-red-500/30 text-red-400',
    purple: 'from-purple-500/20 to-transparent border-purple-500/30 text-purple-400',
    orange: 'from-orange-500/20 to-transparent border-orange-500/30 text-orange-400'
  };

  return (
    <div className={`bg-gradient-to-b ${colorClasses[color]} border rounded-xl p-4`}>
      <div className="text-gray-400 text-xs uppercase tracking-wide mb-1">{title}</div>
      <div className={`text-2xl font-bold ${colorClasses[color].split(' ').pop()}`}>{value}</div>
      {subtitle && <div className="text-gray-400 text-xs mt-1">{subtitle}</div>}
    </div>
  );
}
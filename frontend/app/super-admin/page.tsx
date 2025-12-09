'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Logo from '@/components/Logo';

interface OverviewData {
  users: { total: number; bySubscription: Record<string, number> };
  businesses: { total: number };
  instances: { total: number; active: number; inactive: number };
  messages: { today: number; thisWeek: number };
  tokenUsage: {
    today: { tokens: number; cost: number };
    thisMonth: { tokens: number; cost: number };
  };
}

export default function SuperAdminPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    const savedToken = localStorage.getItem('superAdminToken');
    if (savedToken) {
      setToken(savedToken);
      fetchOverview(savedToken);
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch('/api/super-admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Login failed');
      }

      localStorage.setItem('superAdminToken', data.token);
      setToken(data.token);
      fetchOverview(data.token);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    if (token) {
      await fetch('/api/super-admin/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    }
    localStorage.removeItem('superAdminToken');
    setToken(null);
    setOverview(null);
  };

  const fetchOverview = async (authToken: string) => {
    try {
      const response = await fetch('/api/super-admin/overview', {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      
      if (response.status === 401) {
        localStorage.removeItem('superAdminToken');
        setToken(null);
        return;
      }
      
      const data = await response.json();
      setOverview(data);
    } catch (err) {
      console.error('Failed to fetch overview:', err);
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-bg p-4">
        <div className="max-w-md w-full">
          <div className="text-center mb-8">
            <div className="flex justify-center mb-4">
              <Logo size="lg" />
            </div>
            <h1 className="text-2xl font-bold text-white">Super Admin</h1>
            <p className="text-gray-400 mt-2">Panel de administracion del sistema</p>
          </div>

          <div className="card">
            <form onSubmit={handleLogin} className="space-y-5">
              {error && (
                <div className="bg-accent-error/10 border border-accent-error/20 text-accent-error px-4 py-3 rounded-lg text-sm">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Usuario
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="input"
                  placeholder="admin"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Contrasena
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input"
                  placeholder="••••••••"
                  required
                />
              </div>

              <button type="submit" disabled={loading} className="btn btn-primary w-full">
                {loading ? 'Iniciando sesion...' : 'Iniciar sesion'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-dark-bg">
      <header className="bg-dark-surface border-b border-dark-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Logo size="sm" />
            <h1 className="text-xl font-bold text-white">Super Admin</h1>
          </div>
          <button onClick={handleLogout} className="btn btn-ghost text-sm">
            Cerrar sesion
          </button>
        </div>
      </header>

      <nav className="bg-dark-surface border-b border-dark-border px-6">
        <div className="flex gap-1 -mb-px">
          {[
            { id: 'overview', label: 'Resumen' },
            { id: 'users', label: 'Usuarios' },
            { id: 'businesses', label: 'Negocios' },
            { id: 'whatsapp', label: 'WhatsApp' },
            { id: 'tokens', label: 'Uso de Tokens' },
            { id: 'messages', label: 'Mensajes' },
            { id: 'billing', label: 'Facturacion' },
            { id: 'system', label: 'Sistema' }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-neon-blue text-neon-blue'
                  : 'border-transparent text-gray-400 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      <main className="p-6">
        {activeTab === 'overview' && overview && <OverviewTab data={overview} />}
        {activeTab === 'users' && <UsersTab token={token} />}
        {activeTab === 'businesses' && <BusinessesTab token={token} />}
        {activeTab === 'whatsapp' && <WhatsAppTab token={token} />}
        {activeTab === 'tokens' && <TokenUsageTab token={token} />}
        {activeTab === 'messages' && <MessagesTab token={token} />}
        {activeTab === 'billing' && <BillingTab token={token} />}
        {activeTab === 'system' && <SystemTab token={token} />}
      </main>
    </div>
  );
}

function StatCard({ title, value, subtitle, color = 'neon' }: { 
  title: string; 
  value: string | number; 
  subtitle?: string;
  color?: 'neon' | 'green' | 'yellow' | 'red';
}) {
  const colorClasses = {
    neon: 'text-neon-blue',
    green: 'text-accent-success',
    yellow: 'text-accent-warning',
    red: 'text-accent-error'
  };
  
  return (
    <div className="card">
      <p className="text-sm text-gray-400">{title}</p>
      <p className={`text-3xl font-bold mt-1 ${colorClasses[color]}`}>{value}</p>
      {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
}

function OverviewTab({ data }: { data: OverviewData }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Usuarios Totales" value={data.users.total} />
        <StatCard title="Negocios" value={data.businesses.total} />
        <StatCard title="Instancias WhatsApp" value={`${data.instances.active}/${data.instances.total}`} subtitle="activas" color="green" />
        <StatCard title="Mensajes Hoy" value={data.messages.today} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">Uso de Tokens (AI)</h3>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-gray-400">Hoy</span>
              <span className="text-white">{data.tokenUsage.today.tokens.toLocaleString()} tokens (${data.tokenUsage.today.cost.toFixed(4)})</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Este mes</span>
              <span className="text-white">{data.tokenUsage.thisMonth.tokens.toLocaleString()} tokens (${data.tokenUsage.thisMonth.cost.toFixed(4)})</span>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">Suscripciones</h3>
          <div className="space-y-2">
            {Object.entries(data.users.bySubscription).map(([status, count]) => (
              <div key={status} className="flex justify-between">
                <span className="text-gray-400">{status}</span>
                <span className="text-white">{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function UsersTab({ token }: { token: string }) {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/super-admin/users', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(data => {
        setUsers(data.users || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [token]);

  if (loading) return <div className="text-gray-400">Cargando usuarios...</div>;

  return (
    <div className="card overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-dark-border">
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Nombre</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Email</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Estado</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Negocios</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Registro</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-b border-dark-border hover:bg-dark-hover">
              <td className="py-3 px-4 text-white">{user.name}</td>
              <td className="py-3 px-4 text-gray-300">{user.email}</td>
              <td className="py-3 px-4">
                <span className={`status-badge ${
                  user.subscriptionStatus === 'ACTIVE' ? 'status-active' :
                  user.subscriptionStatus === 'TRIAL' ? 'status-trial' :
                  user.subscriptionStatus === 'PAST_DUE' ? 'status-warning' : 'status-error'
                }`}>
                  {user.subscriptionStatus}
                </span>
              </td>
              <td className="py-3 px-4 text-gray-300">{user._count?.businesses || 0}</td>
              <td className="py-3 px-4 text-gray-400 text-sm">{new Date(user.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BusinessesTab({ token }: { token: string }) {
  const [businesses, setBusinesses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/super-admin/businesses', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(data => {
        setBusinesses(data.businesses || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [token]);

  if (loading) return <div className="text-gray-400">Cargando negocios...</div>;

  return (
    <div className="card overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-dark-border">
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Negocio</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Usuario</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Instancias</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Mensajes</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Productos</th>
          </tr>
        </thead>
        <tbody>
          {businesses.map((biz) => (
            <tr key={biz.id} className="border-b border-dark-border hover:bg-dark-hover">
              <td className="py-3 px-4 text-white">{biz.name}</td>
              <td className="py-3 px-4 text-gray-300">{biz.user?.email}</td>
              <td className="py-3 px-4 text-gray-300">{biz.instances?.length || 0}</td>
              <td className="py-3 px-4 text-gray-300">{biz._count?.messages || 0}</td>
              <td className="py-3 px-4 text-gray-300">{biz._count?.products || 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TokenUsageTab({ token }: { token: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/super-admin/token-usage', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <div className="text-gray-400">Cargando uso de tokens...</div>;
  if (!data || !data.totals) return <div className="text-gray-400">No hay datos disponibles</div>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Tokens Totales" value={(data.totals.totalTokens || 0).toLocaleString()} />
        <StatCard title="Tokens Prompt" value={(data.totals.promptTokens || 0).toLocaleString()} />
        <StatCard title="Tokens Completion" value={(data.totals.completionTokens || 0).toLocaleString()} />
        <StatCard title="Costo Total" value={`$${(data.totals.totalCost || 0).toFixed(4)}`} color="yellow" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">Por Funcionalidad</h3>
          <div className="space-y-2">
            {data.byFeature?.map((f: any) => (
              <div key={f.feature} className="flex justify-between">
                <span className="text-gray-400">{f.feature}</span>
                <span className="text-white">{f.tokens.toLocaleString()} (${f.cost.toFixed(4)})</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">Top 10 Negocios</h3>
          <div className="space-y-2">
            {data.topBusinesses?.map((b: any, i: number) => (
              <div key={b.businessId} className="flex justify-between">
                <span className="text-gray-400">#{i + 1} {b.businessId.substring(0, 8)}...</span>
                <span className="text-white">{b.tokens.toLocaleString()} (${b.cost.toFixed(4)})</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MessagesTab({ token }: { token: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/super-admin/messages/stats', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <div className="text-gray-400">Cargando estadisticas...</div>;
  if (!data) return <div className="text-gray-400">No hay datos disponibles</div>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Total Mensajes" value={data.total.toLocaleString()} />
        <StatCard title="Hoy" value={data.today.total} subtitle={`${data.today.inbound} in / ${data.today.outbound} out`} color="green" />
        <StatCard title="Ayer" value={data.yesterday.total} subtitle={`${data.yesterday.inbound} in / ${data.yesterday.outbound} out`} />
        <StatCard title="Esta Semana" value={data.thisWeek.total} subtitle={`${data.thisWeek.inbound} in / ${data.thisWeek.outbound} out`} />
      </div>
    </div>
  );
}

function BillingTab({ token }: { token: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/super-admin/billing', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <div className="text-gray-400">Cargando facturacion...</div>;
  if (!data) return <div className="text-gray-400">No hay datos disponibles</div>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Total Suscriptores" value={data.summary.total} />
        <StatCard title="Activos" value={data.summary.byStatus?.ACTIVE || 0} color="green" />
        <StatCard title="En Trial" value={data.summary.byStatus?.TRIAL || 0} color="neon" />
        <StatCard title="Trial por Vencer" value={data.summary.trialEndingSoon} color="yellow" />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-dark-border">
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Usuario</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Estado</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Fin Trial</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Stripe ID</th>
            </tr>
          </thead>
          <tbody>
            {data.users?.map((user: any) => (
              <tr key={user.id} className="border-b border-dark-border hover:bg-dark-hover">
                <td className="py-3 px-4 text-white">{user.email}</td>
                <td className="py-3 px-4">
                  <span className={`status-badge ${
                    user.subscriptionStatus === 'ACTIVE' ? 'status-active' :
                    user.subscriptionStatus === 'TRIAL' ? 'status-trial' : 'status-warning'
                  }`}>
                    {user.subscriptionStatus}
                  </span>
                </td>
                <td className="py-3 px-4 text-gray-300">
                  {user.trialEndAt ? new Date(user.trialEndAt).toLocaleDateString() : '-'}
                </td>
                <td className="py-3 px-4 text-gray-400 text-sm font-mono">
                  {user.stripeCustomerId || '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SystemTab({ token }: { token: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/super-admin/system-health', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <div className="text-gray-400">Cargando estado del sistema...</div>;
  if (!data) return <div className="text-gray-400">No hay datos disponibles</div>;

  const formatUptime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard 
          title="Estado General" 
          value={data.status === 'healthy' ? 'Saludable' : 'Degradado'} 
          color={data.status === 'healthy' ? 'green' : 'yellow'} 
        />
        <StatCard title="Entorno" value={data.environment} />
        <StatCard title="Uptime" value={formatUptime(data.uptime)} color="green" />
      </div>

      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-4">Servicios</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Object.entries(data.services).map(([service, status]) => (
            <div key={service} className="flex items-center justify-between p-3 bg-dark-card rounded-lg">
              <span className="text-gray-300 capitalize">{service}</span>
              <span className={`status-badge ${
                status === 'connected' || status === 'configured' ? 'status-active' : 'status-error'
              }`}>
                {String(status)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function WhatsAppTab({ token }: { token: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchInstances = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/super-admin/wa-instances', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await response.json();
      setData(result);
    } catch (err) {
      console.error('Failed to fetch WA instances:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInstances();
  }, [token]);

  const handleDelete = async (instanceId: string, deleteFromDb: boolean) => {
    const confirmMsg = deleteFromDb 
      ? 'Esto eliminara la instancia del WhatsApp API Y de la base de datos. Continuar?'
      : 'Esto desconectara la instancia del WhatsApp API (se mantendra en la BD). Continuar?';
    
    if (!confirm(confirmMsg)) return;
    
    setActionLoading(instanceId);
    try {
      await fetch(`/api/super-admin/wa-instances/${instanceId}?deleteFromDb=${deleteFromDb}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      await fetchInstances();
    } catch (err) {
      console.error('Failed to delete instance:', err);
      alert('Error al eliminar instancia');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRestart = async (instanceId: string) => {
    setActionLoading(instanceId);
    try {
      await fetch(`/api/super-admin/wa-instances/${instanceId}/restart`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      await fetchInstances();
    } catch (err) {
      console.error('Failed to restart instance:', err);
      alert('Error al reiniciar instancia');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) return <div className="text-gray-400">Cargando instancias de WhatsApp...</div>;
  if (!data) return <div className="text-gray-400">No se pudo conectar al WhatsApp API</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Instancias WhatsApp API</h2>
        <button onClick={fetchInstances} className="btn btn-ghost text-sm">
          Actualizar
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Total" value={data.summary?.total || 0} />
        <StatCard title="Conectadas" value={data.summary?.connected || 0} color="green" />
        <StatCard title="Esperando QR" value={data.summary?.requiresQr || 0} color="yellow" />
        <StatCard title="Huerfanas" value={data.summary?.orphaned || 0} color="red" />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-dark-border">
              <th className="text-left py-3 px-4 text-gray-400 font-medium">ID Instancia</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Estado</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Negocio</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Usuario</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">En BD</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Ultima Conexion</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {data.instances?.map((inst: any) => (
              <tr key={inst.id} className="border-b border-dark-border hover:bg-dark-hover">
                <td className="py-3 px-4 text-white font-mono text-sm">{inst.id}</td>
                <td className="py-3 px-4">
                  <span className={`status-badge ${
                    inst.status === 'connected' ? 'status-active' :
                    inst.status === 'requires_qr' ? 'status-trial' :
                    'status-warning'
                  }`}>
                    {inst.status}
                  </span>
                </td>
                <td className="py-3 px-4 text-gray-300">{inst.businessName || '-'}</td>
                <td className="py-3 px-4 text-gray-300 text-sm">{inst.userEmail || '-'}</td>
                <td className="py-3 px-4">
                  {inst.inDatabase ? (
                    <span className="text-accent-success">Si</span>
                  ) : (
                    <span className="text-accent-error">No (huerfana)</span>
                  )}
                </td>
                <td className="py-3 px-4 text-gray-400 text-sm">
                  {inst.lastConnection ? new Date(inst.lastConnection).toLocaleString() : '-'}
                </td>
                <td className="py-3 px-4">
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleRestart(inst.id)}
                      disabled={actionLoading === inst.id}
                      className="text-xs px-2 py-1 bg-neon-blue/20 text-neon-blue rounded hover:bg-neon-blue/30 disabled:opacity-50"
                    >
                      {actionLoading === inst.id ? '...' : 'Reiniciar'}
                    </button>
                    <button
                      onClick={() => handleDelete(inst.id, false)}
                      disabled={actionLoading === inst.id}
                      className="text-xs px-2 py-1 bg-accent-warning/20 text-accent-warning rounded hover:bg-accent-warning/30 disabled:opacity-50"
                    >
                      Desconectar
                    </button>
                    <button
                      onClick={() => handleDelete(inst.id, true)}
                      disabled={actionLoading === inst.id}
                      className="text-xs px-2 py-1 bg-accent-error/20 text-accent-error rounded hover:bg-accent-error/30 disabled:opacity-50"
                    >
                      Eliminar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card bg-dark-card/50 border-accent-warning/20">
        <h4 className="text-accent-warning font-medium mb-2">Informacion</h4>
        <ul className="text-sm text-gray-400 space-y-1">
          <li><strong>Desconectar:</strong> Elimina la instancia del WhatsApp API pero mantiene el registro en la base de datos</li>
          <li><strong>Eliminar:</strong> Elimina completamente la instancia del API y de la base de datos</li>
          <li><strong>Huerfana:</strong> Instancia activa en el API pero sin registro en la base de datos (limpiar manualmente)</li>
        </ul>
      </div>
    </div>
  );
}

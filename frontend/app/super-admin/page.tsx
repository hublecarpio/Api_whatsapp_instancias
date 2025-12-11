'use client';

import { useState, useEffect, Fragment } from 'react';
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
  const [activeTab, setActiveTab] = useState('command');

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
      <header className="bg-dark-surface border-b border-dark-border px-3 sm:px-6 py-3 sm:py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-4">
            <Logo size="sm" />
            <h1 className="text-base sm:text-xl font-bold text-white">Super Admin</h1>
          </div>
          <button onClick={handleLogout} className="btn btn-ghost text-xs sm:text-sm px-2 sm:px-4">
            Salir
          </button>
        </div>
      </header>

      <nav className="bg-dark-surface/80 backdrop-blur-sm border-b border-dark-border/50 px-2 sm:px-6 sticky top-0 z-10">
        <div className="flex gap-1 sm:gap-2 -mb-px overflow-x-auto scrollbar-hide py-1">
          {[
            { id: 'command', label: 'Comando', icon: '⚡' },
            { id: 'devconsole', label: 'Console', icon: '🔧' },
            { id: 'users', label: 'Usuarios', icon: '👥' },
            { id: 'businesses', label: 'Negocios', icon: '🏢' },
            { id: 'whatsapp', label: 'WhatsApp', icon: '📱' },
            { id: 'analytics', label: 'Ventas', icon: '📊' },
            { id: 'billing', label: 'Billing', icon: '💳' },
            { id: 'tokens', label: 'Tokens', icon: '🎯' },
            { id: 'agentv2', label: 'Agent V2', icon: '🤖' },
            { id: 'referrals', label: 'Referidos', icon: '🔗' },
            { id: 'system', label: 'Sistema', icon: '⚙️' }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 sm:px-5 py-2.5 sm:py-3 text-xs sm:text-sm font-medium rounded-t-lg transition-all duration-200 whitespace-nowrap flex items-center gap-1.5 ${
                activeTab === tab.id
                  ? 'bg-gradient-to-b from-neon-blue/20 to-transparent border-b-2 border-neon-blue text-neon-blue shadow-lg shadow-neon-blue/10'
                  : 'border-b-2 border-transparent text-gray-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <span className="text-sm sm:text-base">{tab.icon}</span>
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>
      </nav>

      <main className="p-3 sm:p-6">
        {activeTab === 'command' && <CommandCenterTab token={token} />}
        {activeTab === 'devconsole' && <DevConsoleTab token={token} />}
        {activeTab === 'overview' && overview && <OverviewTab data={overview} />}
        {activeTab === 'analytics' && <AnalyticsTab token={token} />}
        {activeTab === 'users' && <UsersTab token={token} />}
        {activeTab === 'businesses' && <BusinessesTab token={token} />}
        {activeTab === 'whatsapp' && <WhatsAppTab token={token} />}
        {activeTab === 'tokens' && <TokenUsageTab token={token} />}
        {activeTab === 'messages' && <MessagesTab token={token} />}
        {activeTab === 'billing' && <BillingTab token={token} />}
        {activeTab === 'agentv2' && <AgentV2Tab token={token} />}
        {activeTab === 'referrals' && <ReferralsTab token={token} />}
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
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchUsers = () => {
    fetch('/api/super-admin/users', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(data => {
        setUsers(data.users || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    fetchUsers();
  }, [token]);

  const handleTogglePro = async (userId: string, currentIsPro: boolean) => {
    if (actionLoading) return;
    setActionLoading(userId);
    
    try {
      const response = await fetch(`/api/super-admin/users/${userId}/pro`, {
        method: 'PATCH',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ isPro: !currentIsPro })
      });
      
      if (response.ok) {
        setUsers(users.map(u => u.id === userId ? { ...u, isPro: !currentIsPro } : u));
      }
    } catch (err) {
      console.error('Failed to toggle Pro:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleTogglePaymentLink = async (userId: string, currentEnabled: boolean) => {
    if (actionLoading) return;
    setActionLoading(userId + '_pl');
    
    try {
      const response = await fetch(`/api/super-admin/users/${userId}/payment-link`, {
        method: 'PATCH',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ paymentLinkEnabled: !currentEnabled })
      });
      
      if (response.ok) {
        setUsers(users.map(u => u.id === userId ? { ...u, paymentLinkEnabled: !currentEnabled } : u));
      }
    } catch (err) {
      console.error('Failed to toggle Payment Link:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteUser = async (userId: string, email: string) => {
    if (actionLoading) return;
    
    if (!confirm(`¿Estas seguro de eliminar al usuario ${email}? Esta accion no se puede deshacer y eliminara todos sus negocios, instancias y datos asociados.`)) {
      return;
    }
    
    setActionLoading(userId);
    
    try {
      const response = await fetch(`/api/super-admin/users/${userId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (response.ok) {
        setUsers(users.filter(u => u.id !== userId));
        alert(`Usuario ${email} eliminado correctamente`);
      } else {
        const data = await response.json();
        alert(`Error al eliminar usuario: ${data.error || data.details || 'Error desconocido'}`);
      }
    } catch (err) {
      console.error('Failed to delete user:', err);
      alert('Error de conexion al intentar eliminar el usuario');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) return <div className="text-gray-400">Cargando usuarios...</div>;

  return (
    <div className="card overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-dark-border">
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Nombre</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Email</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Estado</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Pro</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Link Pago</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Negocios</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Registro</th>
            <th className="text-left py-3 px-4 text-gray-400 font-medium">Acciones</th>
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
              <td className="py-3 px-4">
                <button
                  onClick={() => handleTogglePro(user.id, user.isPro)}
                  disabled={actionLoading === user.id}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    user.isPro 
                      ? 'bg-accent-primary/20 text-accent-primary border border-accent-primary/30 hover:bg-accent-primary/30' 
                      : 'bg-gray-700/50 text-gray-400 border border-gray-600 hover:bg-gray-600/50'
                  }`}
                >
                  {actionLoading === user.id ? '...' : user.isPro ? 'PRO' : 'Standard'}
                </button>
              </td>
              <td className="py-3 px-4">
                <button
                  onClick={() => handleTogglePaymentLink(user.id, user.paymentLinkEnabled)}
                  disabled={actionLoading === user.id + '_pl'}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    user.paymentLinkEnabled 
                      ? 'bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30' 
                      : 'bg-gray-700/50 text-gray-400 border border-gray-600 hover:bg-gray-600/50'
                  }`}
                >
                  {actionLoading === user.id + '_pl' ? '...' : user.paymentLinkEnabled ? 'Activo' : 'Voucher'}
                </button>
              </td>
              <td className="py-3 px-4 text-gray-300">{user._count?.businesses || 0}</td>
              <td className="py-3 px-4 text-gray-400 text-sm">{new Date(user.createdAt).toLocaleDateString()}</td>
              <td className="py-3 px-4">
                <button
                  onClick={() => handleDeleteUser(user.id, user.email)}
                  disabled={actionLoading === user.id}
                  className="text-red-400 hover:text-red-300 text-sm font-medium disabled:opacity-50"
                >
                  {actionLoading === user.id ? '...' : 'Eliminar'}
                </button>
              </td>
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
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  const exportToCSV = () => {
    const headers = ['ID', 'Nombre', 'Usuario', 'Objetivo', 'Zona Horaria', 'Instancias', 'Mensajes', 'Productos', 'Bot Activo', 'Agente', 'Creado'];
    const rows = businesses.map(biz => [
      biz.id,
      biz.name,
      biz.user?.email || '',
      biz.businessObjective || 'SALES',
      biz.timezone || 'America/Lima',
      biz.instances?.length || 0,
      biz._count?.messages || 0,
      biz._count?.products || 0,
      biz.botEnabled ? 'Si' : 'No',
      biz.agentVersion?.toUpperCase() || 'V1',
      new Date(biz.createdAt).toLocaleDateString()
    ]);
    
    const csvContent = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `negocios_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div className="text-gray-400">Cargando negocios...</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div className="text-center sm:text-left">
          <h2 className="text-lg sm:text-xl font-bold text-white">Negocios ({businesses.length})</h2>
          <p className="text-gray-400 text-xs sm:text-sm">Gestion de negocios registrados</p>
        </div>
        <button onClick={exportToCSV} className="btn btn-primary text-xs sm:text-sm flex items-center gap-2 justify-center">
          <span>📥</span> Exportar CSV
        </button>
      </div>

      <div className="hidden md:block card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-dark-border">
              <th className="text-left py-3 px-4 text-gray-400 font-medium"></th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Negocio</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Usuario</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Objetivo</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Instancias</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Mensajes</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Productos</th>
            </tr>
          </thead>
          <tbody>
            {businesses.map((biz) => (
              <Fragment key={biz.id}>
                <tr 
                  className="border-b border-dark-border hover:bg-dark-hover cursor-pointer"
                  onClick={() => setExpandedId(expandedId === biz.id ? null : biz.id)}
                >
                  <td className="py-3 px-4 text-gray-400">
                    <span className={`transition-transform inline-block ${expandedId === biz.id ? 'rotate-90' : ''}`}>▶</span>
                  </td>
                  <td className="py-3 px-4 text-white font-medium">{biz.name}</td>
                  <td className="py-3 px-4 text-gray-300">{biz.user?.email}</td>
                  <td className="py-3 px-4">
                    <span className={`px-2 py-0.5 rounded text-xs ${biz.businessObjective === 'APPOINTMENTS' ? 'bg-purple-500/20 text-purple-400' : 'bg-neon-blue/20 text-neon-blue'}`}>
                      {biz.businessObjective === 'APPOINTMENTS' ? 'Citas' : 'Ventas'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-gray-300">{biz.instances?.length || 0}</td>
                  <td className="py-3 px-4 text-gray-300">{biz._count?.messages || 0}</td>
                  <td className="py-3 px-4 text-gray-300">{biz._count?.products || 0}</td>
                </tr>
                {expandedId === biz.id && (
                  <tr className="bg-dark-hover/50">
                    <td colSpan={7} className="px-4 py-4">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <p className="text-gray-500 text-xs">ID</p>
                          <p className="text-gray-300 font-mono text-xs truncate">{biz.id}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 text-xs">Email Negocio</p>
                          <p className="text-gray-300">{biz.email || '-'}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 text-xs">Telefono</p>
                          <p className="text-gray-300">{biz.phone || '-'}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 text-xs">Zona Horaria</p>
                          <p className="text-gray-300">{biz.timezone || 'America/Lima'}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 text-xs">Bot Activo</p>
                          <p className={biz.botEnabled ? 'text-accent-success' : 'text-gray-500'}>{biz.botEnabled ? 'Si' : 'No'}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 text-xs">Agente</p>
                          <p className="text-purple-400">{biz.agentVersion?.toUpperCase() || 'V1'}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 text-xs">Creado</p>
                          <p className="text-gray-300">{new Date(biz.createdAt).toLocaleDateString()}</p>
                        </div>
                        {biz.systemPrompt && (
                          <div className="col-span-2 md:col-span-4">
                            <p className="text-gray-500 text-xs mb-1">Prompt del Sistema</p>
                            <p className="text-gray-400 text-xs bg-dark-bg p-2 rounded max-h-24 overflow-y-auto">{biz.systemPrompt.substring(0, 500)}{biz.systemPrompt.length > 500 ? '...' : ''}</p>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="md:hidden space-y-3">
        {businesses.map((biz) => (
          <div key={biz.id} className="card">
            <div 
              className="flex items-center justify-between cursor-pointer"
              onClick={() => setExpandedId(expandedId === biz.id ? null : biz.id)}
            >
              <div className="flex-1 min-w-0">
                <p className="text-white font-medium truncate">{biz.name}</p>
                <p className="text-gray-400 text-xs truncate">{biz.user?.email}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`px-2 py-0.5 rounded text-xs ${biz.businessObjective === 'APPOINTMENTS' ? 'bg-purple-500/20 text-purple-400' : 'bg-neon-blue/20 text-neon-blue'}`}>
                  {biz.businessObjective === 'APPOINTMENTS' ? 'Citas' : 'Ventas'}
                </span>
                <span className={`transition-transform ${expandedId === biz.id ? 'rotate-90' : ''}`}>▶</span>
              </div>
            </div>
            
            {expandedId === biz.id && (
              <div className="mt-4 pt-4 border-t border-dark-border grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-gray-500 text-xs">Instancias</p>
                  <p className="text-neon-blue font-bold">{biz.instances?.length || 0}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs">Mensajes</p>
                  <p className="text-white font-bold">{biz._count?.messages || 0}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs">Productos</p>
                  <p className="text-accent-warning font-bold">{biz._count?.products || 0}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs">Bot Activo</p>
                  <p className={biz.botEnabled ? 'text-accent-success' : 'text-gray-500'}>{biz.botEnabled ? 'Si' : 'No'}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs">Agente</p>
                  <p className="text-purple-400">{biz.agentVersion?.toUpperCase() || 'V1'}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs">Zona Horaria</p>
                  <p className="text-gray-300">{biz.timezone || 'America/Lima'}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-gray-500 text-xs">ID</p>
                  <p className="text-gray-400 font-mono text-xs truncate">{biz.id}</p>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
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
          <h3 className="text-lg font-semibold text-white mb-4">Por Proveedor</h3>
          <div className="space-y-2">
            {data.byProvider?.map((p: any) => (
              <div key={p.provider} className="flex justify-between items-center">
                <span className="text-gray-400 flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${p.provider === 'openai' ? 'bg-green-500' : 'bg-blue-500'}`}></span>
                  {p.provider.toUpperCase()}
                </span>
                <span className="text-white">{p.tokens.toLocaleString()} (${p.cost.toFixed(4)})</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">Por Modelo</h3>
          <div className="space-y-2">
            {data.byModel?.map((m: any) => (
              <div key={m.model} className="flex justify-between">
                <span className="text-gray-400 text-sm">{m.model}</span>
                <span className="text-white">{m.tokens.toLocaleString()} (${m.cost.toFixed(4)})</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">Por Funcionalidad</h3>
          <div className="space-y-2">
            {data.byFeature?.map((f: any) => {
              const featureLabels: Record<string, { label: string; icon: string }> = {
                'ai_agent': { label: 'Agente IA (Chat)', icon: '🤖' },
                'reminder': { label: 'Recordatorios', icon: '⏰' },
                'audio_transcription': { label: 'Transcripcion Audio', icon: '🎵' },
                'image_analysis': { label: 'Analisis Imagen', icon: '🖼️' },
                'video_analysis': { label: 'Analisis Video', icon: '🎬' },
                'lead_stage_analysis': { label: 'Analisis de Etapa', icon: '📊' },
                'contact_extraction': { label: 'Extraccion Datos', icon: '📋' },
                'product_search': { label: 'Busqueda Productos', icon: '🔍' }
              };
              const info = featureLabels[f.feature] || { label: f.feature, icon: '📌' };
              return (
                <div key={f.feature} className="flex justify-between items-center">
                  <span className="text-gray-400 flex items-center gap-2">
                    <span>{info.icon}</span>
                    {info.label}
                  </span>
                  <span className="text-white">{f.tokens.toLocaleString()} (${f.cost.toFixed(4)})</span>
                </div>
              );
            })}
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
  if (!data || !data.summary) return <div className="text-gray-400">No hay datos disponibles</div>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Total Suscriptores" value={data.summary?.total || 0} />
        <StatCard title="Activos" value={data.summary?.byStatus?.ACTIVE || 0} color="green" />
        <StatCard title="En Trial" value={data.summary?.byStatus?.TRIAL || 0} color="neon" />
        <StatCard title="Trial por Vencer" value={data.summary?.trialEndingSoon || 0} color="yellow" />
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

      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <StatCard title="Total" value={data.summary?.total || 0} />
        <StatCard title="Conectadas" value={data.summary?.connected || 0} color="green" />
        <StatCard title="Esperando QR" value={data.summary?.requiresQr || 0} color="yellow" />
        <StatCard title="Huerfanas" value={data.summary?.orphaned || 0} color="red" />
        <StatCard title="Baileys" value={data.summary?.baileys || 0} color="neon" />
        <StatCard title="Meta Cloud" value={data.summary?.metaCloud || 0} color="green" />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-dark-border">
              <th className="text-left py-3 px-4 text-gray-400 font-medium">ID Instancia</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Tipo</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Estado</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Telefono</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Negocio</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Usuario</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">En BD</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {data.instances?.map((inst: any) => (
              <tr key={inst.id} className="border-b border-dark-border hover:bg-dark-hover">
                <td className="py-3 px-4 text-white font-mono text-sm">{inst.id?.substring(0, 12)}...</td>
                <td className="py-3 px-4">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${
                    inst.provider === 'META_CLOUD' 
                      ? 'bg-green-500/20 text-green-400' 
                      : 'bg-blue-500/20 text-blue-400'
                  }`}>
                    {inst.provider === 'META_CLOUD' ? 'Meta Cloud' : 'Baileys'}
                  </span>
                </td>
                <td className="py-3 px-4">
                  <span className={`status-badge ${
                    inst.status === 'connected' ? 'status-active' :
                    inst.status === 'requires_qr' ? 'status-trial' :
                    'status-warning'
                  }`}>
                    {inst.status}
                  </span>
                </td>
                <td className="py-3 px-4 text-gray-300 text-sm">{inst.phoneNumber || '-'}</td>
                <td className="py-3 px-4 text-gray-300">{inst.businessName || '-'}</td>
                <td className="py-3 px-4 text-gray-300 text-sm">{inst.userEmail || '-'}</td>
                <td className="py-3 px-4">
                  {inst.inDatabase ? (
                    <span className="text-accent-success">Si</span>
                  ) : (
                    <span className="text-accent-error">No (huerfana)</span>
                  )}
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

interface OrdersAnalytics {
  summary: {
    totalOrders: number;
    totalRevenue: number;
    byStatus: Record<string, { count: number; amount: number }>;
  };
  byBusiness: Array<{
    businessId: string;
    businessName: string;
    count: number;
    totalAmount: number;
  }>;
  recentOrders: Array<{
    id: string;
    status: string;
    totalAmount: number;
    currencySymbol: string;
    contactPhone: string;
    contactName: string | null;
    businessName: string;
    itemCount: number;
    createdAt: string;
  }>;
}

interface PaymentLinksAnalytics {
  summary: {
    totalRequests: number;
    successCount: number;
    failureCount: number;
    successRate: number;
  };
  byBusiness: Array<{
    businessId: string;
    businessName: string;
    count: number;
  }>;
  bySource: Record<string, number>;
  topFailureReasons: Array<{
    reason: string | null;
    count: number;
  }>;
  recentRequests: Array<{
    id: string;
    businessName: string;
    contactPhone: string | null;
    productName: string | null;
    amount: number | null;
    quantity: number;
    isSuccess: boolean;
    failureReason: string | null;
    isPro: boolean;
    triggerSource: string;
    createdAt: string;
  }>;
}

function AnalyticsTab({ token }: { token: string }) {
  const [ordersData, setOrdersData] = useState<OrdersAnalytics | null>(null);
  const [paymentLinksData, setPaymentLinksData] = useState<PaymentLinksAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<'orders' | 'payment-links'>('orders');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (startDate) params.append('startDate', startDate);
      if (endDate) params.append('endDate', endDate);
      
      const [ordersRes, paymentLinksRes] = await Promise.all([
        fetch(`/api/super-admin/analytics/orders?${params}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch(`/api/super-admin/analytics/payment-links?${params}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
      ]);
      
      if (ordersRes.ok) {
        setOrdersData(await ordersRes.json());
      }
      if (paymentLinksRes.ok) {
        setPaymentLinksData(await paymentLinksRes.json());
      }
    } catch (err) {
      console.error('Failed to fetch analytics:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [token]);

  const handleApplyFilters = () => {
    fetchData();
  };

  const statusColors: Record<string, string> = {
    PENDING_PAYMENT: 'text-accent-warning',
    AWAITING_VOUCHER: 'text-neon-purple',
    PAID: 'text-accent-success',
    CANCELLED: 'text-accent-error',
    REFUNDED: 'text-gray-400'
  };

  const statusLabels: Record<string, string> = {
    PENDING_PAYMENT: 'Pendiente de Pago',
    AWAITING_VOUCHER: 'Esperando Voucher',
    PAID: 'Pagado',
    CANCELLED: 'Cancelado',
    REFUNDED: 'Reembolsado'
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-gray-400">Cargando analytics...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Fecha inicio</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="input text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Fecha fin</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="input text-sm"
            />
          </div>
          <button onClick={handleApplyFilters} className="btn btn-primary">
            Aplicar filtros
          </button>
        </div>
      </div>

      <div className="flex gap-2 border-b border-dark-border pb-2">
        <button
          onClick={() => setActiveSection('orders')}
          className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
            activeSection === 'orders'
              ? 'bg-neon-blue/20 text-neon-blue border border-neon-blue/30 border-b-transparent'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          Pedidos
        </button>
        <button
          onClick={() => setActiveSection('payment-links')}
          className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
            activeSection === 'payment-links'
              ? 'bg-neon-blue/20 text-neon-blue border border-neon-blue/30 border-b-transparent'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          Enlaces de Pago
        </button>
      </div>

      {activeSection === 'orders' && ordersData && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard title="Total Pedidos" value={ordersData.summary.totalOrders} />
            <StatCard 
              title="Ingresos Totales" 
              value={`S/.${ordersData.summary.totalRevenue.toLocaleString()}`} 
              subtitle="Solo pedidos pagados"
              color="green"
            />
            <StatCard 
              title="Pendientes de Pago" 
              value={ordersData.summary.byStatus.PENDING_PAYMENT?.count || 0} 
              color="yellow"
            />
            <StatCard 
              title="Pagados" 
              value={ordersData.summary.byStatus.PAID?.count || 0} 
              color="green"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Pedidos por Estado</h3>
              <div className="space-y-3">
                {Object.entries(ordersData.summary.byStatus).map(([status, data]) => (
                  <div key={status} className="flex justify-between items-center">
                    <span className={statusColors[status] || 'text-gray-400'}>
                      {statusLabels[status] || status}
                    </span>
                    <div className="text-right">
                      <span className="text-white font-medium">{data.count}</span>
                      <span className="text-gray-500 text-sm ml-2">
                        (S/.{data.amount.toLocaleString()})
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Top Negocios por Pedidos</h3>
              <div className="space-y-3 max-h-64 overflow-y-auto">
                {ordersData.byBusiness.slice(0, 10).map((b) => (
                  <div key={b.businessId} className="flex justify-between items-center">
                    <span className="text-gray-300 truncate max-w-[60%]">{b.businessName}</span>
                    <div className="text-right">
                      <span className="text-white font-medium">{b.count}</span>
                      <span className="text-gray-500 text-sm ml-2">
                        (S/.{b.totalAmount.toLocaleString()})
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <h3 className="text-lg font-semibold text-white mb-4">Pedidos Recientes</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-dark-border">
                    <th className="pb-3">Negocio</th>
                    <th className="pb-3">Cliente</th>
                    <th className="pb-3">Monto</th>
                    <th className="pb-3">Items</th>
                    <th className="pb-3">Estado</th>
                    <th className="pb-3">Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {ordersData.recentOrders.map((order) => (
                    <tr key={order.id} className="border-b border-dark-border/50">
                      <td className="py-3 text-gray-300">{order.businessName}</td>
                      <td className="py-3">
                        <div className="text-white">{order.contactName || '-'}</div>
                        <div className="text-gray-500 text-xs">{order.contactPhone}</div>
                      </td>
                      <td className="py-3 text-white">
                        {order.currencySymbol}{order.totalAmount.toLocaleString()}
                      </td>
                      <td className="py-3 text-gray-400">{order.itemCount}</td>
                      <td className="py-3">
                        <span className={`px-2 py-1 rounded text-xs ${statusColors[order.status] || 'text-gray-400'}`}>
                          {statusLabels[order.status] || order.status}
                        </span>
                      </td>
                      <td className="py-3 text-gray-400">
                        {new Date(order.createdAt).toLocaleDateString('es-PE')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeSection === 'payment-links' && paymentLinksData && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard title="Total Solicitudes" value={paymentLinksData.summary.totalRequests} />
            <StatCard 
              title="Exitosas" 
              value={paymentLinksData.summary.successCount} 
              color="green"
            />
            <StatCard 
              title="Fallidas" 
              value={paymentLinksData.summary.failureCount} 
              color="red"
            />
            <StatCard 
              title="Tasa de Exito" 
              value={`${paymentLinksData.summary.successRate}%`} 
              color={paymentLinksData.summary.successRate >= 80 ? 'green' : paymentLinksData.summary.successRate >= 50 ? 'yellow' : 'red'}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Por Origen</h3>
              <div className="space-y-3">
                {Object.entries(paymentLinksData.bySource).map(([source, count]) => (
                  <div key={source} className="flex justify-between items-center">
                    <span className="text-gray-300 capitalize">{source}</span>
                    <span className="text-white font-medium">{count}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Top Negocios</h3>
              <div className="space-y-3 max-h-64 overflow-y-auto">
                {paymentLinksData.byBusiness.slice(0, 10).map((b) => (
                  <div key={b.businessId} className="flex justify-between items-center">
                    <span className="text-gray-300 truncate max-w-[70%]">{b.businessName}</span>
                    <span className="text-white font-medium">{b.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {paymentLinksData.topFailureReasons.length > 0 && (
            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-4">Razones de Fallo mas Comunes</h3>
              <div className="space-y-2">
                {paymentLinksData.topFailureReasons.map((f, i) => (
                  <div key={i} className="flex justify-between items-center">
                    <span className="text-gray-300">{f.reason || 'Sin especificar'}</span>
                    <span className="text-accent-error font-medium">{f.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <h3 className="text-lg font-semibold text-white mb-4">Solicitudes Recientes</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-dark-border">
                    <th className="pb-3">Negocio</th>
                    <th className="pb-3">Producto</th>
                    <th className="pb-3">Monto</th>
                    <th className="pb-3">Origen</th>
                    <th className="pb-3">Pro</th>
                    <th className="pb-3">Estado</th>
                    <th className="pb-3">Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentLinksData.recentRequests.map((req) => (
                    <tr key={req.id} className="border-b border-dark-border/50">
                      <td className="py-3 text-gray-300">{req.businessName}</td>
                      <td className="py-3 text-white">{req.productName || '-'}</td>
                      <td className="py-3 text-white">
                        {req.amount ? `S/.${req.amount.toLocaleString()}` : '-'}
                      </td>
                      <td className="py-3 text-gray-400 capitalize">{req.triggerSource}</td>
                      <td className="py-3">
                        {req.isPro ? (
                          <span className="text-neon-purple">Pro</span>
                        ) : (
                          <span className="text-gray-500">Free</span>
                        )}
                      </td>
                      <td className="py-3">
                        {req.isSuccess ? (
                          <span className="text-accent-success">Exitoso</span>
                        ) : (
                          <span className="text-accent-error" title={req.failureReason || ''}>
                            Fallido
                          </span>
                        )}
                      </td>
                      <td className="py-3 text-gray-400">
                        {new Date(req.createdAt).toLocaleDateString('es-PE')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentV2Tab({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStats();
  }, [token]);

  const fetchStats = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/super-admin/agent-v2-stats', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (!response.ok) throw new Error('Failed to fetch stats');
      
      const result = await response.json();
      setData(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="text-gray-400">Cargando estadisticas de Agent V2...</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <StatCard title="Negocios V2" value={data.summary.totalV2Businesses} color="neon" />
        <StatCard title="Memorias de Leads" value={data.summary.totalLeadMemories} color="green" />
        <StatCard title="Reglas Aprendidas" value={data.summary.totalLearnedRules} color="yellow" />
        <StatCard title="Reglas Activas" value={data.summary.activeRulesCount} color="green" />
        <StatCard title="Aplicaciones de Reglas" value={data.summary.totalRuleApplications} color="neon" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">Negocios usando Agent V2</h3>
          {data.businesses.length === 0 ? (
            <p className="text-gray-500">Ningun negocio esta usando Agent V2 aun</p>
          ) : (
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-dark-surface">
                  <tr className="border-b border-dark-border">
                    <th className="text-left py-2 text-gray-400 font-medium text-sm">Negocio</th>
                    <th className="text-left py-2 text-gray-400 font-medium text-sm">Usuario</th>
                    <th className="text-center py-2 text-gray-400 font-medium text-sm">Memorias</th>
                    <th className="text-center py-2 text-gray-400 font-medium text-sm">Reglas</th>
                  </tr>
                </thead>
                <tbody>
                  {data.businesses.map((b: any) => (
                    <tr key={b.id} className="border-b border-dark-border hover:bg-dark-hover">
                      <td className="py-2 text-white">{b.name}</td>
                      <td className="py-2 text-gray-300 text-sm">{b.userEmail}</td>
                      <td className="py-2 text-center text-neon-blue">{b.memoryCount}</td>
                      <td className="py-2 text-center text-accent-warning">{b.ruleCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">Reglas Aprendidas Recientes</h3>
          {data.recentRules.length === 0 ? (
            <p className="text-gray-500">No hay reglas aprendidas aun</p>
          ) : (
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {data.recentRules.map((rule: any) => (
                <div key={rule.id} className="bg-dark-bg p-3 rounded-lg border border-dark-border">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-white text-sm flex-1">{rule.rule}</p>
                    <span className={`text-xs px-2 py-0.5 rounded ${rule.enabled ? 'bg-accent-success/20 text-accent-success' : 'bg-gray-700 text-gray-400'}`}>
                      {rule.enabled ? 'Activa' : 'Inactiva'}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                    <span>Fuente: {rule.source}</span>
                    <span>Aplicada: {rule.appliedCount}x</span>
                    <span>{new Date(rule.createdAt).toLocaleDateString('es-PE')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-4">Memorias de Leads Recientes</h3>
        {data.recentMemories.length === 0 ? (
          <p className="text-gray-500">No hay memorias de leads aun</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-dark-border">
                  <th className="text-left py-2 text-gray-400 font-medium text-sm">Telefono</th>
                  <th className="text-left py-2 text-gray-400 font-medium text-sm">Nombre</th>
                  <th className="text-left py-2 text-gray-400 font-medium text-sm">Etapa</th>
                  <th className="text-left py-2 text-gray-400 font-medium text-sm">Ultima actualizacion</th>
                </tr>
              </thead>
              <tbody>
                {data.recentMemories.map((m: any) => (
                  <tr key={m.id} className="border-b border-dark-border hover:bg-dark-hover">
                    <td className="py-2 text-white font-mono text-sm">{m.leadPhone}</td>
                    <td className="py-2 text-gray-300">{m.leadName || '-'}</td>
                    <td className="py-2">
                      <span className="text-xs px-2 py-0.5 rounded bg-neon-blue/20 text-neon-blue">
                        {m.stage || 'Sin etapa'}
                      </span>
                    </td>
                    <td className="py-2 text-gray-400 text-sm">
                      {new Date(m.updatedAt).toLocaleString('es-PE')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

interface ReferralCode {
  id: string;
  code: string;
  description: string | null;
  type: 'STANDARD' | 'ENTERPRISE';
  grantTier: 'STANDARD' | 'PRO' | 'ENTERPRISE' | null;
  grantDurationDays: number | null;
  maxUses: number | null;
  usageCount: number;
  isActive: boolean;
  expiresAt: string | null;
  createdAt: string;
  registeredUsers: number;
}

function ReferralsTab({ token }: { token: string }) {
  const [codes, setCodes] = useState<ReferralCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newExpiresAt, setNewExpiresAt] = useState('');
  const [newType, setNewType] = useState<'STANDARD' | 'ENTERPRISE'>('STANDARD');
  const [newGrantDurationDays, setNewGrantDurationDays] = useState('');
  const [newMaxUses, setNewMaxUses] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  useEffect(() => {
    fetchCodes();
  }, [token]);

  const fetchCodes = async () => {
    try {
      const res = await fetch('/api/super-admin/referral-codes', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setCodes(data.codes || []);
    } catch (err) {
      console.error('Error fetching codes:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError('');

    if (newType === 'ENTERPRISE' && !newGrantDurationDays) {
      setError('Los codigos Enterprise requieren una duracion en dias');
      setCreating(false);
      return;
    }

    try {
      const res = await fetch('/api/super-admin/referral-codes', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          code: newCode,
          description: newDescription || null,
          expiresAt: newExpiresAt || null,
          type: newType,
          grantTier: newType === 'ENTERPRISE' ? 'PRO' : null,
          grantDurationDays: newType === 'ENTERPRISE' ? parseInt(newGrantDurationDays) : null,
          maxUses: newMaxUses ? parseInt(newMaxUses) : null
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Error al crear codigo');
      }

      setNewCode('');
      setNewDescription('');
      setNewExpiresAt('');
      setNewType('STANDARD');
      setNewGrantDurationDays('');
      setNewMaxUses('');
      setShowCreateModal(false);
      fetchCodes();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (id: string, isActive: boolean) => {
    try {
      await fetch(`/api/super-admin/referral-codes/${id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ isActive: !isActive })
      });
      fetchCodes();
    } catch (err) {
      console.error('Error toggling code:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Eliminar este codigo de referido?')) return;
    
    try {
      await fetch(`/api/super-admin/referral-codes/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      fetchCodes();
    } catch (err) {
      console.error('Error deleting code:', err);
    }
  };

  const handleViewUsers = async (code: string) => {
    setSelectedCode(code);
    setLoadingUsers(true);
    
    try {
      const res = await fetch(`/api/super-admin/referral-codes/${code}/users`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setUsers(data.users || []);
    } catch (err) {
      console.error('Error fetching users:', err);
    } finally {
      setLoadingUsers(false);
    }
  };

  const totalRegistered = codes.reduce((sum, c) => sum + c.registeredUsers, 0);
  const activeCodes = codes.filter(c => c.isActive).length;
  const enterpriseCodes = codes.filter(c => c.type === 'ENTERPRISE').length;

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-2 border-neon-blue border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-white">Codigos de Referido</h2>
          <p className="text-gray-400 text-sm mt-1">
            Gestiona codigos para marketing y tracking de registros
          </p>
        </div>
        <button 
          onClick={() => setShowCreateModal(true)}
          className="btn btn-primary"
        >
          + Crear Codigo
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="card text-center">
          <p className="text-3xl font-bold text-neon-blue">{codes.length}</p>
          <p className="text-gray-400 text-sm">Total Codigos</p>
        </div>
        <div className="card text-center">
          <p className="text-3xl font-bold text-accent-success">{activeCodes}</p>
          <p className="text-gray-400 text-sm">Codigos Activos</p>
        </div>
        <div className="card text-center">
          <p className="text-3xl font-bold text-purple-400">{enterpriseCodes}</p>
          <p className="text-gray-400 text-sm">Enterprise</p>
        </div>
        <div className="card text-center">
          <p className="text-3xl font-bold text-white">{totalRegistered}</p>
          <p className="text-gray-400 text-sm">Usuarios Registrados</p>
        </div>
      </div>

      <div className="card">
        {codes.length === 0 ? (
          <p className="text-gray-500 text-center py-8">No hay codigos de referido creados</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-dark-border">
                <th className="text-left py-3 text-gray-400 font-medium">Codigo</th>
                <th className="text-left py-3 text-gray-400 font-medium">Tipo</th>
                <th className="text-left py-3 text-gray-400 font-medium">Descripcion</th>
                <th className="text-center py-3 text-gray-400 font-medium">Usos</th>
                <th className="text-center py-3 text-gray-400 font-medium">Estado</th>
                <th className="text-left py-3 text-gray-400 font-medium">Expiracion</th>
                <th className="text-right py-3 text-gray-400 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {codes.map(code => (
                <tr key={code.id} className="border-b border-dark-border hover:bg-dark-hover">
                  <td className="py-3">
                    <span className="font-mono text-white bg-dark-bg px-2 py-1 rounded">
                      {code.code}
                    </span>
                  </td>
                  <td className="py-3">
                    {code.type === 'ENTERPRISE' ? (
                      <div className="flex flex-col gap-1">
                        <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-400 font-medium w-fit">
                          ENTERPRISE
                        </span>
                        <span className="text-xs text-gray-400">
                          PRO x {code.grantDurationDays} dias
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded bg-gray-500/20 text-gray-400">
                        STANDARD
                      </span>
                    )}
                  </td>
                  <td className="py-3 text-gray-300 text-sm max-w-[200px] truncate">
                    {code.description || <span className="text-gray-500">-</span>}
                  </td>
                  <td className="py-3 text-center">
                    <button 
                      onClick={() => handleViewUsers(code.code)}
                      className="text-neon-blue hover:underline"
                    >
                      {code.registeredUsers}
                      {code.maxUses && <span className="text-gray-500">/{code.maxUses}</span>}
                    </button>
                  </td>
                  <td className="py-3 text-center">
                    <button
                      onClick={() => handleToggleActive(code.id, code.isActive)}
                      className={`text-xs px-2 py-1 rounded ${
                        code.isActive 
                          ? 'bg-accent-success/20 text-accent-success' 
                          : 'bg-gray-500/20 text-gray-500'
                      }`}
                    >
                      {code.isActive ? 'Activo' : 'Inactivo'}
                    </button>
                  </td>
                  <td className="py-3 text-gray-400 text-sm">
                    {code.expiresAt 
                      ? new Date(code.expiresAt).toLocaleDateString('es-PE')
                      : '-'}
                  </td>
                  <td className="py-3 text-right">
                    <button
                      onClick={() => handleDelete(code.id)}
                      className="text-accent-error hover:underline text-sm"
                    >
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-white mb-4">Crear Codigo de Referido</h3>
            <form onSubmit={handleCreate} className="space-y-4">
              {error && (
                <div className="bg-accent-error/10 border border-accent-error/20 text-accent-error px-3 py-2 rounded text-sm">
                  {error}
                </div>
              )}
              <div>
                <label className="block text-sm text-gray-400 mb-1">Tipo de Codigo *</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setNewType('STANDARD')}
                    className={`flex-1 py-2 px-3 rounded text-sm font-medium transition-colors ${
                      newType === 'STANDARD'
                        ? 'bg-gray-600 text-white'
                        : 'bg-dark-bg text-gray-400 hover:bg-dark-hover'
                    }`}
                  >
                    Standard
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewType('ENTERPRISE')}
                    className={`flex-1 py-2 px-3 rounded text-sm font-medium transition-colors ${
                      newType === 'ENTERPRISE'
                        ? 'bg-purple-600 text-white'
                        : 'bg-dark-bg text-gray-400 hover:bg-dark-hover'
                    }`}
                  >
                    Enterprise
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {newType === 'ENTERPRISE' 
                    ? 'Activa PRO automaticamente al registrarse' 
                    : 'Solo tracking de marketing'}
                </p>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Codigo *</label>
                <input
                  type="text"
                  value={newCode}
                  onChange={e => setNewCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  className="input w-full"
                  placeholder="SIETEDIASGRATIS"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Descripcion</label>
                <input
                  type="text"
                  value={newDescription}
                  onChange={e => setNewDescription(e.target.value)}
                  className="input w-full"
                  placeholder="Cliente enterprise - Acme Corp"
                />
              </div>
              {newType === 'ENTERPRISE' && (
                <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-4 space-y-4">
                  <p className="text-purple-400 text-sm font-medium">Configuracion Enterprise</p>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Duracion PRO (dias) *</label>
                    <input
                      type="number"
                      value={newGrantDurationDays}
                      onChange={e => setNewGrantDurationDays(e.target.value)}
                      className="input w-full"
                      placeholder="30"
                      min="1"
                      required={newType === 'ENTERPRISE'}
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Limite de usos</label>
                    <input
                      type="number"
                      value={newMaxUses}
                      onChange={e => setNewMaxUses(e.target.value)}
                      className="input w-full"
                      placeholder="Ilimitado"
                      min="1"
                    />
                    <p className="text-xs text-gray-500 mt-1">Dejar vacio para usos ilimitados</p>
                  </div>
                </div>
              )}
              <div>
                <label className="block text-sm text-gray-400 mb-1">Fecha de expiracion</label>
                <input
                  type="date"
                  value={newExpiresAt}
                  onChange={e => setNewExpiresAt(e.target.value)}
                  className="input w-full"
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setError('');
                    setNewType('STANDARD');
                    setNewGrantDurationDays('');
                    setNewMaxUses('');
                  }}
                  className="btn btn-ghost flex-1"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={creating || !newCode}
                  className={`flex-1 ${newType === 'ENTERPRISE' ? 'btn bg-purple-600 hover:bg-purple-700 text-white' : 'btn btn-primary'}`}
                >
                  {creating ? 'Creando...' : 'Crear'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedCode && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card max-w-2xl w-full mx-4 max-h-[80vh] overflow-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-white">
                Usuarios con codigo: <span className="text-neon-blue">{selectedCode}</span>
              </h3>
              <button onClick={() => setSelectedCode(null)} className="text-gray-400 hover:text-white">
                X
              </button>
            </div>
            {loadingUsers ? (
              <div className="flex justify-center py-8">
                <div className="w-6 h-6 border-2 border-neon-blue border-t-transparent rounded-full animate-spin" />
              </div>
            ) : users.length === 0 ? (
              <p className="text-gray-500 text-center py-8">No hay usuarios registrados con este codigo</p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-dark-border">
                    <th className="text-left py-2 text-gray-400 font-medium text-sm">Nombre</th>
                    <th className="text-left py-2 text-gray-400 font-medium text-sm">Email</th>
                    <th className="text-left py-2 text-gray-400 font-medium text-sm">Suscripcion</th>
                    <th className="text-left py-2 text-gray-400 font-medium text-sm">Registro</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u: any) => (
                    <tr key={u.id} className="border-b border-dark-border">
                      <td className="py-2 text-white">{u.name}</td>
                      <td className="py-2 text-gray-300">{u.email}</td>
                      <td className="py-2">
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          u.subscriptionStatus === 'active' 
                            ? 'bg-accent-success/20 text-accent-success'
                            : 'bg-gray-500/20 text-gray-400'
                        }`}>
                          {u.subscriptionStatus}
                        </span>
                      </td>
                      <td className="py-2 text-gray-400 text-sm">
                        {new Date(u.createdAt).toLocaleDateString('es-PE')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface CommandCenterData {
  health: { status: string; errors24h: number };
  users: { active: number; newToday: number };
  whatsapp: { connectedInstances: number };
  platform: { 
    stripeSubscribers: number; 
    enterpriseSubscribers: number; 
    totalPaying: number;
    revenueWeekly: number; 
    revenueMRR: number;
  };
  activity: { messagesToday: number; ordersToday: number; tokenCostToday: number };
  pending: { reminders: number };
  recentActivity: any[];
}

function CommandCenterTab({ token }: { token: string }) {
  const [data, setData] = useState<CommandCenterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchData = async () => {
    try {
      const res = await fetch('/api/super-admin/command-center', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await res.json();
      setData(result);
    } catch (err) {
      console.error('Error fetching command center:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    let interval: NodeJS.Timeout;
    if (autoRefresh) {
      interval = setInterval(fetchData, 10000);
    }
    return () => clearInterval(interval);
  }, [token, autoRefresh]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-2 border-neon-blue border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!data) return null;

  const healthColors = {
    healthy: 'bg-accent-success',
    warning: 'bg-accent-warning',
    degraded: 'bg-accent-error'
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div className="text-center sm:text-left">
          <h2 className="text-xl sm:text-2xl font-bold text-white">Centro de Comando</h2>
          <p className="text-gray-400 text-xs sm:text-sm">Vista unificada del sistema</p>
        </div>
        <div className="flex items-center justify-center sm:justify-end gap-2 sm:gap-4">
          <label className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm text-gray-400">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="rounded w-3 h-3 sm:w-4 sm:h-4"
            />
            Auto (10s)
          </label>
          <button onClick={fetchData} className="btn btn-ghost text-xs sm:text-sm px-2 sm:px-4">
            Actualizar
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-4">
        <div className="card flex items-center justify-center gap-2 sm:gap-3 col-span-2 sm:col-span-1">
          <div className={`w-3 h-3 sm:w-4 sm:h-4 rounded-full ${healthColors[data.health.status as keyof typeof healthColors] || 'bg-gray-500'}`} />
          <div>
            <p className="text-base sm:text-xl font-bold text-white capitalize">{data.health.status}</p>
            <p className="text-[10px] sm:text-xs text-gray-400">Estado</p>
          </div>
        </div>
        <div className="card text-center p-2 sm:p-4">
          <p className="text-xl sm:text-3xl font-bold text-neon-blue">{data.users.active}</p>
          <p className="text-[10px] sm:text-xs text-gray-400">Usuarios</p>
          {data.users.newToday > 0 && (
            <p className="text-[10px] sm:text-xs text-accent-success">+{data.users.newToday}</p>
          )}
        </div>
        <div className="card text-center p-2 sm:p-4">
          <p className="text-xl sm:text-3xl font-bold text-accent-success">{data.whatsapp.connectedInstances}</p>
          <p className="text-[10px] sm:text-xs text-gray-400">WhatsApp</p>
        </div>
        <div className="card text-center p-2 sm:p-4">
          <p className="text-xl sm:text-3xl font-bold text-white">{data.activity.messagesToday}</p>
          <p className="text-[10px] sm:text-xs text-gray-400">Mensajes</p>
        </div>
        <div className="card text-center p-2 sm:p-4">
          <p className="text-xl sm:text-3xl font-bold text-accent-warning">{data.health.errors24h}</p>
          <p className="text-[10px] sm:text-xs text-gray-400">Errores</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
        <div className="card bg-gradient-to-br from-accent-success/10 to-transparent border-accent-success/30 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-400">Suscriptores</p>
          <p className="text-lg sm:text-2xl font-bold text-accent-success">{data.platform?.totalPaying || 0}</p>
          <p className="text-[10px] text-gray-500">
            {data.platform?.stripeSubscribers || 0} Stripe · {data.platform?.enterpriseSubscribers || 0} Enterprise
          </p>
        </div>
        <div className="card bg-gradient-to-br from-green-500/10 to-transparent border-green-500/30 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-400">Ingresos/Semana</p>
          <p className="text-lg sm:text-2xl font-bold text-green-400">${data.platform?.revenueWeekly || 0}</p>
          <p className="text-[10px] text-gray-500">MRR: ${data.platform?.revenueMRR || 0}</p>
        </div>
        <div className="card bg-gradient-to-br from-neon-blue/10 to-transparent border-neon-blue/30 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-400">Pedidos Hoy</p>
          <p className="text-lg sm:text-2xl font-bold text-neon-blue">{data.activity.ordersToday}</p>
        </div>
        <div className="card bg-gradient-to-br from-purple-500/10 to-transparent border-purple-500/30 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-400">Costo IA (Hoy)</p>
          <p className="text-lg sm:text-2xl font-bold text-purple-400">${(data.activity.tokenCostToday || 0).toFixed(2)}</p>
        </div>
        <div className="card bg-gradient-to-br from-accent-warning/10 to-transparent border-accent-warning/30 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-400">Reminders</p>
          <p className="text-lg sm:text-2xl font-bold text-accent-warning">{data.pending.reminders}</p>
        </div>
      </div>

      <div className="card p-3 sm:p-4">
        <h3 className="text-base sm:text-lg font-semibold text-white mb-3 sm:mb-4">Actividad Reciente</h3>
        {data.recentActivity.length === 0 ? (
          <p className="text-gray-500 text-center py-4 text-sm">No hay actividad reciente</p>
        ) : (
          <div className="space-y-1 sm:space-y-2 max-h-64 sm:max-h-96 overflow-y-auto">
            {data.recentActivity.map((event: any) => (
              <div key={event.id} className="flex items-start sm:items-center gap-2 sm:gap-3 py-1.5 sm:py-2 border-b border-dark-border">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1 sm:mt-0 ${
                  event.severity === 'ERROR' || event.severity === 'CRITICAL' ? 'bg-accent-error' :
                  event.severity === 'WARNING' ? 'bg-accent-warning' : 'bg-accent-success'
                }`} />
                <div className="flex-1 min-w-0">
                  <span className="text-xs sm:text-sm text-gray-300 block truncate">{event.message}</span>
                  <span className="text-[10px] sm:text-xs text-gray-500">{event.source}</span>
                </div>
                <span className="text-[10px] sm:text-xs text-gray-500 flex-shrink-0">
                  {new Date(event.createdAt).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface SystemEvent {
  id: string;
  eventType: string;
  severity: string;
  source: string;
  message: string;
  details?: any;
  businessId?: string;
  businessName?: string;
  userId?: string;
  createdAt: string;
}

function DevConsoleTab({ token }: { token: string }) {
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [severityFilter, setSeverityFilter] = useState<string>('');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [businessFilter, setBusinessFilter] = useState<string>('');
  const [showDebug, setShowDebug] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [sources, setSources] = useState<{source: string; count: number}[]>([]);
  const [businesses, setBusinesses] = useState<{id: string; name: string}[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<SystemEvent | null>(null);

  const fetchBusinesses = async () => {
    try {
      const res = await fetch('/api/super-admin/businesses', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setBusinesses(data.businesses?.map((b: any) => ({ id: b.id, name: b.name })) || []);
    } catch (err) {
      console.error('Error fetching businesses:', err);
    }
  };

  const fetchEvents = async () => {
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (severityFilter) {
        params.append('severity', severityFilter);
      } else if (!showDebug) {
        params.append('excludeDebug', 'true');
      }
      if (sourceFilter) params.append('source', sourceFilter);
      if (businessFilter) params.append('businessId', businessFilter);
      
      const [eventsRes, statsRes, sourcesRes] = await Promise.all([
        fetch(`/api/super-admin/events?${params}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch('/api/super-admin/events/stats', {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch('/api/super-admin/events/sources', {
          headers: { 'Authorization': `Bearer ${token}` }
        })
      ]);

      const eventsData = await eventsRes.json();
      const statsData = await statsRes.json();
      const sourcesData = await sourcesRes.json();

      setEvents(eventsData.events || []);
      setStats(statsData);
      setSources(sourcesData.sources || []);
    } catch (err) {
      console.error('Error fetching events:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBusinesses();
  }, [token]);

  useEffect(() => {
    fetchEvents();
    let interval: NodeJS.Timeout;
    if (autoRefresh) {
      interval = setInterval(fetchEvents, 5000);
    }
    return () => clearInterval(interval);
  }, [token, autoRefresh, severityFilter, sourceFilter, businessFilter, showDebug]);

  const severityColors: Record<string, string> = {
    DEBUG: 'text-gray-500 bg-gray-500/10',
    INFO: 'text-neon-blue bg-neon-blue/10',
    WARNING: 'text-accent-warning bg-accent-warning/10',
    ERROR: 'text-accent-error bg-accent-error/10',
    CRITICAL: 'text-red-500 bg-red-500/20 font-bold'
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-2 border-neon-blue border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-3 sm:space-y-4">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div className="text-center sm:text-left">
          <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center justify-center sm:justify-start gap-2">
            Dev Console
            <span className="text-xs sm:text-sm font-normal text-gray-400 bg-dark-surface px-2 py-0.5 sm:py-1 rounded">
              {events.length}
            </span>
          </h2>
          <p className="text-gray-400 text-xs sm:text-sm">Logs en tiempo real</p>
        </div>
        <div className="flex items-center justify-center sm:justify-end gap-2 sm:gap-4">
          <label className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm text-gray-400">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="rounded w-3 h-3 sm:w-4 sm:h-4"
            />
            Auto (5s)
          </label>
          <button onClick={fetchEvents} className="btn btn-ghost text-xs sm:text-sm px-2 sm:px-4">
            Actualizar
          </button>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 sm:gap-3">
          <div className="card py-2 sm:py-3 text-center">
            <p className="text-lg sm:text-2xl font-bold text-neon-blue">{stats.counts?.today || 0}</p>
            <p className="text-[10px] sm:text-xs text-gray-400">Hoy</p>
          </div>
          <div className="card py-2 sm:py-3 text-center">
            <p className="text-lg sm:text-2xl font-bold text-white">{stats.counts?.lastHour || 0}</p>
            <p className="text-[10px] sm:text-xs text-gray-400">1h</p>
          </div>
          <div className="card py-2 sm:py-3 text-center">
            <p className="text-lg sm:text-2xl font-bold text-accent-error">{stats.counts?.errors24h || 0}</p>
            <p className="text-[10px] sm:text-xs text-gray-400">Errores</p>
          </div>
          <div className="card py-2 sm:py-3 text-center hidden sm:block">
            <p className="text-lg sm:text-2xl font-bold text-accent-success">{stats.bySeverity?.INFO || 0}</p>
            <p className="text-[10px] sm:text-xs text-gray-400">Info</p>
          </div>
          <div className="card py-2 sm:py-3 text-center hidden sm:block">
            <p className="text-lg sm:text-2xl font-bold text-accent-warning">{stats.bySeverity?.WARNING || 0}</p>
            <p className="text-[10px] sm:text-xs text-gray-400">Warn</p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 sm:gap-3 items-center">
        <select
          value={severityFilter}
          onChange={e => setSeverityFilter(e.target.value)}
          className="input text-xs sm:text-sm flex-1 min-w-[100px] sm:flex-none sm:w-36"
        >
          <option value="">Severidad</option>
          <option value="DEBUG">DEBUG</option>
          <option value="INFO">INFO</option>
          <option value="WARNING">WARNING</option>
          <option value="ERROR">ERROR</option>
          <option value="CRITICAL">CRITICAL</option>
        </select>
        <select
          value={sourceFilter}
          onChange={e => setSourceFilter(e.target.value)}
          className="input text-xs sm:text-sm flex-1 min-w-[100px] sm:flex-none sm:w-40"
        >
          <option value="">Fuente</option>
          {sources.map(s => (
            <option key={s.source} value={s.source}>{s.source} ({s.count})</option>
          ))}
        </select>
        <select
          value={businessFilter}
          onChange={e => setBusinessFilter(e.target.value)}
          className="input text-xs sm:text-sm flex-1 min-w-[100px] sm:flex-none sm:w-48"
        >
          <option value="">Todos los negocios</option>
          {businesses.map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={showDebug}
            onChange={e => setShowDebug(e.target.checked)}
            className="rounded w-3 h-3"
          />
          DEBUG
        </label>
        <button 
          onClick={() => { setSeverityFilter(''); setSourceFilter(''); setBusinessFilter(''); }}
          className="btn btn-ghost text-xs sm:text-sm px-2 sm:px-4"
        >
          Limpiar
        </button>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="bg-dark-bg font-mono text-xs sm:text-sm max-h-[400px] sm:max-h-[600px] overflow-y-auto">
          {events.length === 0 ? (
            <p className="text-gray-500 text-center py-8 text-sm">No hay eventos</p>
          ) : (
            events.map(event => (
              <div 
                key={event.id}
                onClick={() => setSelectedEvent(event)}
                className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-2 px-2 sm:px-3 py-2 border-b border-dark-border hover:bg-dark-hover cursor-pointer"
              >
                <div className="flex items-center gap-2 sm:contents">
                  <span className="text-gray-600 text-[10px] sm:text-xs sm:w-20 flex-shrink-0">
                    {new Date(event.createdAt).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className={`text-[10px] sm:text-xs px-1 sm:px-1.5 py-0.5 rounded sm:w-16 text-center flex-shrink-0 ${severityColors[event.severity] || ''}`}>
                    {event.severity}
                  </span>
                  <span className="text-purple-400 text-[10px] sm:text-xs sm:w-24 flex-shrink-0 truncate">
                    {event.source}
                  </span>
                  {event.businessName && (
                    <span className="text-neon-blue text-[10px] sm:text-xs sm:w-28 flex-shrink-0 truncate hidden sm:inline">
                      {event.businessName}
                    </span>
                  )}
                </div>
                <span className="text-gray-300 text-xs sm:text-sm flex-1 truncate">{event.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {selectedEvent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-3">
          <div className="card w-full max-w-2xl max-h-[90vh] overflow-auto">
            <div className="flex justify-between items-center mb-3 sm:mb-4">
              <h3 className="text-base sm:text-lg font-semibold text-white">Detalle del Evento</h3>
              <button onClick={() => setSelectedEvent(null)} className="text-gray-400 hover:text-white text-xl px-2">
                X
              </button>
            </div>
            <div className="space-y-2 sm:space-y-3 text-xs sm:text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-gray-500">Tipo</p>
                  <p className="text-white font-mono">{selectedEvent.eventType}</p>
                </div>
                <div>
                  <p className="text-gray-500">Severidad</p>
                  <span className={`text-xs px-2 py-1 rounded ${severityColors[selectedEvent.severity]}`}>
                    {selectedEvent.severity}
                  </span>
                </div>
                <div>
                  <p className="text-gray-500">Fuente</p>
                  <p className="text-purple-400 font-mono">{selectedEvent.source}</p>
                </div>
                <div>
                  <p className="text-gray-500">Fecha</p>
                  <p className="text-white">{new Date(selectedEvent.createdAt).toLocaleString('es-PE')}</p>
                </div>
              </div>
              <div>
                <p className="text-gray-500">Mensaje</p>
                <p className="text-white bg-dark-bg p-2 rounded">{selectedEvent.message}</p>
              </div>
              {selectedEvent.businessId && (
                <div>
                  <p className="text-gray-500">Negocio</p>
                  <p className="text-neon-blue">{selectedEvent.businessName || 'Sin nombre'}</p>
                  <p className="text-gray-400 font-mono text-xs">{selectedEvent.businessId}</p>
                </div>
              )}
              {selectedEvent.userId && (
                <div>
                  <p className="text-gray-500">User ID</p>
                  <p className="text-gray-300 font-mono text-xs">{selectedEvent.userId}</p>
                </div>
              )}
              {selectedEvent.details && (
                <div>
                  <p className="text-gray-500">Detalles</p>
                  <pre className="text-gray-300 bg-dark-bg p-2 rounded overflow-x-auto text-xs">
                    {JSON.stringify(selectedEvent.details, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

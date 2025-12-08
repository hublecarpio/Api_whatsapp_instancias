'use client';

import { useState, useEffect, useCallback } from 'react';
import { useBusinessStore } from '@/store/business';
import { useAuthStore } from '@/store/auth';
import { waApi, businessApi } from '@/lib/api';

interface ConnectionEvent {
  type: string;
  message: string;
  timestamp: Date;
}

interface MetaFormData {
  name: string;
  accessToken: string;
  metaBusinessId: string;
  phoneNumberId: string;
  appId: string;
  appSecret: string;
}

export default function WhatsAppPage() {
  const { currentBusiness, setCurrentBusiness } = useBusinessStore();
  const { user } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [provider, setProvider] = useState<string>('BAILEYS');
  const [qrCode, setQrCode] = useState<string>('');
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [error, setError] = useState('');
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [events, setEvents] = useState<ConnectionEvent[]>([]);
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [showMetaForm, setShowMetaForm] = useState(false);
  const [metaInfo, setMetaInfo] = useState<any>(null);
  const [webhookInfo, setWebhookInfo] = useState<{ url: string; token: string } | null>(null);
  
  const [metaForm, setMetaForm] = useState<MetaFormData>({
    name: '',
    accessToken: '',
    metaBusinessId: '',
    phoneNumberId: '',
    appId: '',
    appSecret: ''
  });

  const addEvent = useCallback((type: string, message: string) => {
    setEvents(prev => [{
      type,
      message,
      timestamp: new Date()
    }, ...prev.slice(0, 9)]);
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!currentBusiness) return;
    
    try {
      const response = await waApi.status(currentBusiness.id);
      const newStatus = response.data.status;
      
      if (newStatus !== status && status !== '') {
        addEvent('status', `Estado: ${getStatusText(newStatus)}`);
      }
      
      setStatus(newStatus);
      setProvider(response.data.provider || 'BAILEYS');
      setPhoneNumber(response.data.phoneNumber || '');
      setLastUpdate(new Date());
      
      if (response.data.metaInfo) {
        setMetaInfo(response.data.metaInfo);
      }
      if (response.data.webhookUrl && response.data.webhookVerifyToken) {
        setWebhookInfo({
          url: response.data.webhookUrl,
          token: response.data.webhookVerifyToken
        });
      }
      
      if (newStatus === 'pending_qr' && response.data.provider !== 'META_CLOUD') {
        const qrResponse = await waApi.qr(currentBusiness.id);
        setQrCode(qrResponse.data.qr || '');
      } else {
        setQrCode('');
      }
    } catch (err: any) {
      if (err.response?.status === 404) {
        setStatus('not_created');
      }
    }
  }, [currentBusiness, status, addEvent]);

  const getStatusText = (s: string) => {
    const texts: Record<string, string> = {
      'not_created': 'Sin configurar',
      'pending_qr': 'Esperando QR',
      'open': 'Conectado',
      'connected': 'Conectado',
      'closed': 'Desconectado',
      'connecting': 'Conectando',
      'error': 'Error'
    };
    return texts[s] || s;
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleCreateBaileys = async () => {
    if (!currentBusiness) return;
    
    setLoading(true);
    setError('');
    setShowProviderModal(false);
    addEvent('action', 'Creando instancia Baileys...');
    
    try {
      await waApi.create(currentBusiness.id);
      addEvent('success', 'Instancia Baileys creada');
      const refreshed = await businessApi.get(currentBusiness.id);
      setCurrentBusiness(refreshed.data);
      await fetchStatus();
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Error al crear instancia';
      setError(errorMsg);
      addEvent('error', errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateMeta = async () => {
    if (!currentBusiness) return;
    
    if (!metaForm.accessToken || !metaForm.metaBusinessId || !metaForm.phoneNumberId || !metaForm.appId || !metaForm.appSecret) {
      setError('Todos los campos son obligatorios');
      return;
    }
    
    setLoading(true);
    setError('');
    addEvent('action', 'Creando instancia Meta Cloud...');
    
    try {
      const response = await waApi.createMeta({
        businessId: currentBusiness.id,
        name: metaForm.name || 'Meta WhatsApp',
        accessToken: metaForm.accessToken,
        metaBusinessId: metaForm.metaBusinessId,
        phoneNumberId: metaForm.phoneNumberId,
        appId: metaForm.appId,
        appSecret: metaForm.appSecret
      });
      
      addEvent('success', 'Instancia Meta Cloud creada');
      setShowMetaForm(false);
      setShowProviderModal(false);
      
      if (response.data.webhookUrl) {
        setWebhookInfo({
          url: response.data.webhookUrl,
          token: response.data.instance.webhookVerifyToken
        });
      }
      
      const refreshed = await businessApi.get(currentBusiness.id);
      setCurrentBusiness(refreshed.data);
      await fetchStatus();
      
      setMetaForm({
        name: '',
        accessToken: '',
        metaBusinessId: '',
        phoneNumberId: '',
        appId: '',
        appSecret: ''
      });
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Error al crear instancia Meta';
      const details = err.response?.data?.details;
      setError(details ? `${errorMsg}: ${details}` : errorMsg);
      addEvent('error', errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleRefreshQR = async () => {
    if (!currentBusiness) return;
    
    setActionLoading('qr');
    setError('');
    addEvent('action', 'Refrescando QR...');
    
    try {
      const qrResponse = await waApi.qr(currentBusiness.id);
      setQrCode(qrResponse.data.qr || '');
      setLastUpdate(new Date());
      addEvent('success', 'QR actualizado');
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Error al obtener QR';
      setError(errorMsg);
      addEvent('error', errorMsg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRestart = async () => {
    if (!currentBusiness) return;
    
    setActionLoading('restart');
    setError('');
    addEvent('action', 'Reiniciando conexion...');
    
    try {
      await waApi.restart(currentBusiness.id);
      addEvent('success', 'Conexion reiniciada');
      await fetchStatus();
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Error al reiniciar';
      setError(errorMsg);
      addEvent('error', errorMsg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    if (!currentBusiness) return;
    if (!confirm('Eliminar conexion de WhatsApp? Tendras que configurar de nuevo.')) return;
    
    setActionLoading('delete');
    setError('');
    addEvent('action', 'Eliminando instancia...');
    
    try {
      await waApi.delete(currentBusiness.id);
      addEvent('success', 'Instancia eliminada');
      const refreshed = await businessApi.get(currentBusiness.id);
      setCurrentBusiness(refreshed.data);
      setStatus('not_created');
      setQrCode('');
      setPhoneNumber('');
      setMetaInfo(null);
      setWebhookInfo(null);
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Error al eliminar';
      setError(errorMsg);
      addEvent('error', errorMsg);
    } finally {
      setActionLoading(null);
    }
  };

  const getStatusBadge = () => {
    const badges: Record<string, { bg: string; dot: string; text: string }> = {
      'not_created': { bg: 'bg-gray-700', dot: 'bg-gray-400', text: 'Sin configurar' },
      'pending_qr': { bg: 'bg-accent-warning/20', dot: 'bg-accent-warning', text: 'Esperando QR' },
      'open': { bg: 'bg-accent-success/20', dot: 'bg-accent-success', text: 'Conectado' },
      'connected': { bg: 'bg-accent-success/20', dot: 'bg-accent-success', text: 'Conectado' },
      'closed': { bg: 'bg-accent-error/20', dot: 'bg-accent-error', text: 'Desconectado' },
      'connecting': { bg: 'bg-neon-blue/20', dot: 'bg-neon-blue', text: 'Conectando' },
      'error': { bg: 'bg-accent-error/20', dot: 'bg-accent-error', text: 'Error' }
    };
    const badge = badges[status] || { bg: 'bg-gray-700', dot: 'bg-gray-400', text: status };
    return (
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-white ${badge.bg}`}>
        <span className={`w-2 h-2 rounded-full ${badge.dot} ${status === 'open' || status === 'connected' ? 'animate-pulse' : ''}`}></span>
        {badge.text}
      </span>
    );
  };

  const getProviderBadge = () => {
    if (provider === 'META_CLOUD') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-neon-blue/20 text-neon-blue">
          <span>📱</span> Meta Cloud API
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-accent-success/20 text-accent-success">
        <span>📲</span> Baileys
      </span>
    );
  };

  const getEventIcon = (type: string) => {
    switch (type) {
      case 'success': return '✓';
      case 'error': return '✕';
      case 'action': return '→';
      case 'status': return '●';
      default: return '•';
    }
  };

  const getEventColor = (type: string) => {
    switch (type) {
      case 'success': return 'text-accent-success';
      case 'error': return 'text-accent-error';
      case 'action': return 'text-neon-blue';
      case 'status': return 'text-gray-400';
      default: return 'text-gray-500';
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    addEvent('success', 'Copiado al portapapeles');
  };

  if (!currentBusiness) {
    return (
      <div className="card text-center py-8">
        <p className="text-gray-400">Primero debes crear una empresa para conectar WhatsApp.</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl sm:text-2xl font-bold text-white">WhatsApp</h1>
          {status !== 'not_created' && (
            <>
              {getStatusBadge()}
              {getProviderBadge()}
            </>
          )}
        </div>
        {phoneNumber && (status === 'open' || status === 'connected') && (
          <span className="text-sm text-gray-400">+{phoneNumber}</span>
        )}
      </div>

      {error && (
        <div className="bg-accent-error/10 border border-accent-error/20 text-accent-error px-3 py-2 rounded-lg mb-3 flex items-center justify-between text-sm">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-accent-error/70 hover:text-accent-error ml-2">✕</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <div className="card">
            {status === 'not_created' && (
              <div className="text-center py-6">
                <div className="text-4xl mb-3">💬</div>
                <h2 className="text-lg font-semibold text-white mb-1">Conecta tu WhatsApp</h2>
                <p className="text-gray-400 text-sm mb-4">Elige como quieres conectar tu cuenta de WhatsApp.</p>
                {user?.emailVerified === false ? (
                  <div className="bg-accent-warning/10 border border-accent-warning/20 rounded-lg p-4 max-w-sm mx-auto">
                    <p className="text-accent-warning text-sm mb-2">Verifica tu correo electrónico para crear instancias de WhatsApp</p>
                    <p className="text-gray-500 text-xs">Revisa tu bandeja de entrada o spam</p>
                  </div>
                ) : (
                  <button onClick={() => setShowProviderModal(true)} disabled={loading} className="btn btn-primary">
                    {loading ? 'Creando...' : 'Crear instancia'}
                  </button>
                )}
              </div>
            )}

            {status === 'pending_qr' && provider !== 'META_CLOUD' && (
              <div className="py-2">
                <div className="text-center mb-3">
                  <h2 className="text-lg font-semibold text-white">Escanea el codigo QR</h2>
                  <p className="text-gray-500 text-xs">WhatsApp → Menu → Dispositivos vinculados → Vincular</p>
                </div>
                
                <div className="flex justify-center mb-3">
                  {qrCode ? (
                    <div className="relative p-2 bg-white rounded-lg">
                      <img src={qrCode} alt="QR Code" className="w-48 h-48" />
                      {actionLoading === 'qr' && (
                        <div className="absolute inset-0 bg-white/80 flex items-center justify-center rounded-lg">
                          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-neon-blue"></div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="w-48 h-48 bg-dark-hover rounded-lg flex items-center justify-center">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-neon-blue"></div>
                    </div>
                  )}
                </div>

                {lastUpdate && (
                  <p className="text-center text-xs text-gray-500 mb-3">
                    Actualizado: {lastUpdate.toLocaleTimeString()}
                  </p>
                )}

                <div className="flex flex-wrap justify-center gap-2">
                  <button onClick={handleRefreshQR} disabled={actionLoading !== null} className="btn btn-secondary btn-sm">
                    {actionLoading === 'qr' ? '...' : 'Refrescar'}
                  </button>
                  <button onClick={handleRestart} disabled={actionLoading !== null} className="btn btn-secondary btn-sm">
                    {actionLoading === 'restart' ? '...' : 'Reiniciar'}
                  </button>
                  <button onClick={handleDelete} disabled={actionLoading !== null} className="btn btn-danger btn-sm">
                    {actionLoading === 'delete' ? '...' : 'Eliminar'}
                  </button>
                </div>
              </div>
            )}

            {(status === 'open' || status === 'connected') && (
              <div className="py-2">
                <div className="flex items-center gap-3 p-3 bg-accent-success/10 border border-accent-success/20 rounded-lg mb-4">
                  <div className="w-10 h-10 bg-accent-success/20 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-xl text-accent-success">✓</span>
                  </div>
                  <div className="flex-1">
                    <h2 className="font-semibold text-white">WhatsApp Conectado</h2>
                    <p className="text-xs text-gray-400">Tu cuenta esta activa y recibiendo mensajes</p>
                    {metaInfo && (
                      <p className="text-xs text-neon-blue mt-1">
                        {metaInfo.verifiedName && `Nombre: ${metaInfo.verifiedName}`}
                        {metaInfo.qualityRating && ` - Calidad: ${metaInfo.qualityRating}`}
                      </p>
                    )}
                  </div>
                </div>

                {provider === 'META_CLOUD' && webhookInfo && (
                  <div className="bg-neon-blue/10 border border-neon-blue/30 p-3 rounded-lg mb-4">
                    <h3 className="text-sm font-semibold text-neon-blue mb-2">Configuracion de Webhook</h3>
                    <div className="space-y-2">
                      <div>
                        <label className="text-xs text-neon-blue/70">URL del Webhook:</label>
                        <div className="flex items-center gap-2">
                          <code className="text-xs bg-dark-hover text-gray-300 px-2 py-1 rounded flex-1 overflow-x-auto">{webhookInfo.url}</code>
                          <button onClick={() => copyToClipboard(webhookInfo.url)} className="text-neon-blue hover:text-cyan-400 text-xs">📋</button>
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-neon-blue/70">Token de verificacion:</label>
                        <div className="flex items-center gap-2">
                          <code className="text-xs bg-dark-hover text-gray-300 px-2 py-1 rounded flex-1">{webhookInfo.token}</code>
                          <button onClick={() => copyToClipboard(webhookInfo.token)} className="text-neon-blue hover:text-cyan-400 text-xs">📋</button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                
                <div className="flex flex-wrap gap-2">
                  {provider !== 'META_CLOUD' && (
                    <button onClick={handleRestart} disabled={actionLoading !== null} className="btn btn-secondary btn-sm">
                      {actionLoading === 'restart' ? '...' : 'Reiniciar'}
                    </button>
                  )}
                  <button onClick={handleDelete} disabled={actionLoading !== null} className="btn btn-danger btn-sm">
                    {actionLoading === 'delete' ? '...' : 'Eliminar'}
                  </button>
                </div>
              </div>
            )}

            {status === 'closed' && (
              <div className="py-2">
                <div className="flex items-center gap-3 p-3 bg-accent-error/10 border border-accent-error/20 rounded-lg mb-4">
                  <div className="w-10 h-10 bg-accent-error/20 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-xl">⚠️</span>
                  </div>
                  <div>
                    <h2 className="font-semibold text-white">Conexion perdida</h2>
                    <p className="text-xs text-gray-400">Reconecta o elimina para empezar de nuevo</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button onClick={handleRestart} disabled={actionLoading !== null} className="btn btn-primary btn-sm">
                    {actionLoading === 'restart' ? '...' : 'Reconectar'}
                  </button>
                  <button onClick={handleDelete} disabled={actionLoading !== null} className="btn btn-danger btn-sm">
                    {actionLoading === 'delete' ? '...' : 'Eliminar'}
                  </button>
                </div>
              </div>
            )}

            {status === 'connecting' && (
              <div className="text-center py-6">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-neon-blue mx-auto mb-3"></div>
                <h2 className="font-semibold text-white">Conectando...</h2>
                <p className="text-gray-400 text-xs">Estableciendo conexion con WhatsApp</p>
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-1 space-y-4">
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
              <span>📋</span> Actividad
            </h3>
            
            {events.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-4">Sin actividad reciente</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {events.map((event, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className={`${getEventColor(event.type)} flex-shrink-0`}>
                      {getEventIcon(event.type)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-300 truncate">{event.message}</p>
                      <p className="text-gray-500">{event.timestamp.toLocaleTimeString()}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h3 className="text-sm font-semibold text-gray-300 mb-2">💡 Ayuda</h3>
            <ul className="text-xs text-gray-400 space-y-1">
              <li><strong className="text-gray-300">Baileys:</strong> Conexion via QR (WhatsApp Web)</li>
              <li><strong className="text-gray-300">Meta Cloud:</strong> API oficial de WhatsApp Business</li>
              <li>• <strong className="text-gray-300">QR no carga:</strong> Refrescar</li>
              <li>• <strong className="text-gray-300">QR expiro:</strong> Reiniciar</li>
            </ul>
          </div>
        </div>
      </div>

      {showProviderModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-lg w-full">
            <h2 className="text-xl font-bold text-white mb-4">Elige el tipo de conexion</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <button
                onClick={handleCreateBaileys}
                disabled={loading}
                className="p-4 border-2 border-dark-hover rounded-xl hover:border-accent-success hover:bg-accent-success/10 transition-all text-left group"
              >
                <div className="text-3xl mb-2">📲</div>
                <h3 className="font-semibold text-white group-hover:text-accent-success">Baileys</h3>
                <p className="text-xs text-gray-400 mt-1">Conexion via codigo QR. Usa la sesion de WhatsApp Web.</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  <span className="px-2 py-0.5 bg-accent-success/20 text-accent-success rounded text-xs">Gratis</span>
                  <span className="px-2 py-0.5 bg-dark-hover text-gray-400 rounded text-xs">Rapido</span>
                </div>
              </button>

              <button
                onClick={() => setShowMetaForm(true)}
                disabled={loading}
                className="p-4 border-2 border-dark-hover rounded-xl hover:border-neon-blue hover:bg-neon-blue/10 transition-all text-left group"
              >
                <div className="text-3xl mb-2">📱</div>
                <h3 className="font-semibold text-white group-hover:text-neon-blue">Meta Cloud API</h3>
                <p className="text-xs text-gray-400 mt-1">API oficial de WhatsApp Business. Requiere cuenta de Meta.</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  <span className="px-2 py-0.5 bg-neon-blue/20 text-neon-blue rounded text-xs">Oficial</span>
                  <span className="px-2 py-0.5 bg-dark-hover text-gray-400 rounded text-xs">Templates</span>
                </div>
              </button>
            </div>

            <button
              onClick={() => setShowProviderModal(false)}
              className="w-full btn btn-secondary"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {showMetaForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-white mb-4">Configurar Meta Cloud API</h2>
            
            <div className="bg-neon-blue/10 border border-neon-blue/30 text-neon-blue px-3 py-2 rounded-lg mb-4 text-xs">
              Necesitas una cuenta de Meta Business Suite y una app de WhatsApp configurada.
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Nombre (opcional)</label>
                <input
                  type="text"
                  value={metaForm.name}
                  onChange={e => setMetaForm(prev => ({ ...prev, name: e.target.value }))}
                  className="input"
                  placeholder="Mi WhatsApp Business"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Access Token *</label>
                <input
                  type="password"
                  value={metaForm.accessToken}
                  onChange={e => setMetaForm(prev => ({ ...prev, accessToken: e.target.value }))}
                  className="input"
                  placeholder="EAAGm..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Meta Business ID *</label>
                <input
                  type="text"
                  value={metaForm.metaBusinessId}
                  onChange={e => setMetaForm(prev => ({ ...prev, metaBusinessId: e.target.value }))}
                  className="input"
                  placeholder="123456789..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Phone Number ID *</label>
                <input
                  type="text"
                  value={metaForm.phoneNumberId}
                  onChange={e => setMetaForm(prev => ({ ...prev, phoneNumberId: e.target.value }))}
                  className="input"
                  placeholder="123456789..."
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">App ID *</label>
                  <input
                    type="text"
                    value={metaForm.appId}
                    onChange={e => setMetaForm(prev => ({ ...prev, appId: e.target.value }))}
                    className="input"
                    placeholder="123456..."
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">App Secret *</label>
                  <input
                    type="password"
                    value={metaForm.appSecret}
                    onChange={e => setMetaForm(prev => ({ ...prev, appSecret: e.target.value }))}
                    className="input"
                    placeholder="abc123..."
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowMetaForm(false);
                  setMetaForm({
                    name: '',
                    accessToken: '',
                    metaBusinessId: '',
                    phoneNumberId: '',
                    appId: '',
                    appSecret: ''
                  });
                }}
                className="flex-1 btn btn-secondary"
              >
                Cancelar
              </button>
              <button
                onClick={handleCreateMeta}
                disabled={loading}
                className="flex-1 btn btn-primary"
              >
                {loading ? 'Conectando...' : 'Conectar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

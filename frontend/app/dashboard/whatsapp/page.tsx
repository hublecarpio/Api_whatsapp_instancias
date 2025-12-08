'use client';

import { useState, useEffect, useCallback } from 'react';
import { useBusinessStore } from '@/store/business';
import { waApi, businessApi } from '@/lib/api';

interface ConnectionEvent {
  type: string;
  message: string;
  timestamp: Date;
}

export default function WhatsAppPage() {
  const { currentBusiness, setCurrentBusiness } = useBusinessStore();
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [qrCode, setQrCode] = useState<string>('');
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [error, setError] = useState('');
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [events, setEvents] = useState<ConnectionEvent[]>([]);

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
      setPhoneNumber(response.data.phoneNumber || '');
      setLastUpdate(new Date());
      
      if (newStatus === 'pending_qr') {
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
      'closed': 'Desconectado',
      'connecting': 'Conectando'
    };
    return texts[s] || s;
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleCreate = async () => {
    if (!currentBusiness) return;
    
    setLoading(true);
    setError('');
    addEvent('action', 'Creando instancia...');
    
    try {
      await waApi.create(currentBusiness.id);
      addEvent('success', 'Instancia creada');
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
    addEvent('action', 'Reiniciando conexión...');
    
    try {
      await waApi.restart(currentBusiness.id);
      addEvent('success', 'Conexión reiniciada');
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
    if (!confirm('¿Eliminar conexión de WhatsApp? Tendrás que escanear el QR de nuevo.')) return;
    
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
      'not_created': { bg: 'bg-gray-100', dot: 'bg-gray-400', text: 'Sin configurar' },
      'pending_qr': { bg: 'bg-yellow-100', dot: 'bg-yellow-500', text: 'Esperando QR' },
      'open': { bg: 'bg-green-100', dot: 'bg-green-500', text: 'Conectado' },
      'closed': { bg: 'bg-red-100', dot: 'bg-red-500', text: 'Desconectado' },
      'connecting': { bg: 'bg-blue-100', dot: 'bg-blue-500', text: 'Conectando' }
    };
    const badge = badges[status] || { bg: 'bg-gray-100', dot: 'bg-gray-400', text: status };
    return (
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${badge.bg}`}>
        <span className={`w-2 h-2 rounded-full ${badge.dot} ${status === 'open' ? 'animate-pulse' : ''}`}></span>
        {badge.text}
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
      case 'success': return 'text-green-600';
      case 'error': return 'text-red-600';
      case 'action': return 'text-blue-600';
      case 'status': return 'text-gray-600';
      default: return 'text-gray-500';
    }
  };

  if (!currentBusiness) {
    return (
      <div className="card text-center py-8">
        <p className="text-gray-600">Primero debes crear una empresa para conectar WhatsApp.</p>
      </div>
    );
  }

  return (
    <div className="h-full">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900">WhatsApp</h1>
          {status !== 'not_created' && getStatusBadge()}
        </div>
        {phoneNumber && status === 'open' && (
          <span className="text-sm text-gray-600">+{phoneNumber}</span>
        )}
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 px-3 py-2 rounded-lg mb-3 flex items-center justify-between text-sm">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-400 hover:text-red-600 ml-2">✕</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <div className="card p-4">
            {status === 'not_created' && (
              <div className="text-center py-6">
                <div className="text-4xl mb-3">💬</div>
                <h2 className="text-lg font-semibold text-gray-900 mb-1">Conecta tu WhatsApp</h2>
                <p className="text-gray-600 text-sm mb-4">Crea una instancia para empezar a recibir mensajes.</p>
                <button onClick={handleCreate} disabled={loading} className="btn btn-primary">
                  {loading ? 'Creando...' : 'Crear instancia'}
                </button>
              </div>
            )}

            {status === 'pending_qr' && (
              <div className="py-2">
                <div className="text-center mb-3">
                  <h2 className="text-lg font-semibold text-gray-900">Escanea el código QR</h2>
                  <p className="text-gray-500 text-xs">WhatsApp → Menú → Dispositivos vinculados → Vincular</p>
                </div>
                
                <div className="flex justify-center mb-3">
                  {qrCode ? (
                    <div className="relative p-2 bg-white rounded-lg border">
                      <img src={qrCode} alt="QR Code" className="w-48 h-48" />
                      {actionLoading === 'qr' && (
                        <div className="absolute inset-0 bg-white/80 flex items-center justify-center rounded-lg">
                          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-green-600"></div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="w-48 h-48 bg-gray-100 rounded-lg flex items-center justify-center border">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-green-600"></div>
                    </div>
                  )}
                </div>

                {lastUpdate && (
                  <p className="text-center text-xs text-gray-400 mb-3">
                    Actualizado: {lastUpdate.toLocaleTimeString()}
                  </p>
                )}

                <div className="flex flex-wrap justify-center gap-2">
                  <button onClick={handleRefreshQR} disabled={actionLoading !== null} className="btn btn-secondary btn-sm">
                    {actionLoading === 'qr' ? '...' : '🔄 Refrescar'}
                  </button>
                  <button onClick={handleRestart} disabled={actionLoading !== null} className="btn btn-secondary btn-sm">
                    {actionLoading === 'restart' ? '...' : '🔁 Reiniciar'}
                  </button>
                  <button onClick={handleDelete} disabled={actionLoading !== null} className="btn btn-danger btn-sm">
                    {actionLoading === 'delete' ? '...' : '🗑️ Eliminar'}
                  </button>
                </div>
              </div>
            )}

            {status === 'open' && (
              <div className="py-2">
                <div className="flex items-center gap-3 p-3 bg-green-50 rounded-lg mb-4">
                  <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-xl">✓</span>
                  </div>
                  <div>
                    <h2 className="font-semibold text-gray-900">WhatsApp Conectado</h2>
                    <p className="text-xs text-gray-500">Tu cuenta está activa y recibiendo mensajes</p>
                  </div>
                </div>
                
                <div className="flex flex-wrap gap-2">
                  <button onClick={handleRestart} disabled={actionLoading !== null} className="btn btn-secondary btn-sm">
                    {actionLoading === 'restart' ? '...' : '🔁 Reiniciar'}
                  </button>
                  <button onClick={handleDelete} disabled={actionLoading !== null} className="btn btn-danger btn-sm">
                    {actionLoading === 'delete' ? '...' : '🗑️ Eliminar'}
                  </button>
                </div>
              </div>
            )}

            {status === 'closed' && (
              <div className="py-2">
                <div className="flex items-center gap-3 p-3 bg-red-50 rounded-lg mb-4">
                  <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-xl">⚠️</span>
                  </div>
                  <div>
                    <h2 className="font-semibold text-gray-900">Conexión perdida</h2>
                    <p className="text-xs text-gray-500">Reconecta o elimina para empezar de nuevo</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button onClick={handleRestart} disabled={actionLoading !== null} className="btn btn-primary btn-sm">
                    {actionLoading === 'restart' ? '...' : '🔁 Reconectar'}
                  </button>
                  <button onClick={handleDelete} disabled={actionLoading !== null} className="btn btn-danger btn-sm">
                    {actionLoading === 'delete' ? '...' : '🗑️ Eliminar'}
                  </button>
                </div>
              </div>
            )}

            {status === 'connecting' && (
              <div className="text-center py-6">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600 mx-auto mb-3"></div>
                <h2 className="font-semibold text-gray-900">Conectando...</h2>
                <p className="text-gray-500 text-xs">Estableciendo conexión con WhatsApp</p>
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-1">
          <div className="card p-3">
            <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
              <span>📋</span> Actividad
            </h3>
            
            {events.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-4">Sin actividad reciente</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {events.map((event, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className={`${getEventColor(event.type)} flex-shrink-0`}>
                      {getEventIcon(event.type)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-700 truncate">{event.message}</p>
                      <p className="text-gray-400">{event.timestamp.toLocaleTimeString()}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card p-3 mt-3">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">💡 Ayuda</h3>
            <ul className="text-xs text-gray-500 space-y-1">
              <li>• <strong>QR no carga:</strong> Refrescar</li>
              <li>• <strong>QR expiró:</strong> Reiniciar</li>
              <li>• <strong>Errores:</strong> Eliminar y crear nuevo</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

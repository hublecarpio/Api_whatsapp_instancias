'use client';

import { useState, useEffect, useCallback } from 'react';
import { useBusinessStore } from '@/store/business';
import { waApi, businessApi } from '@/lib/api';

export default function WhatsAppPage() {
  const { currentBusiness, setCurrentBusiness } = useBusinessStore();
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [qrCode, setQrCode] = useState<string>('');
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [error, setError] = useState('');
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!currentBusiness) return;
    
    try {
      const response = await waApi.status(currentBusiness.id);
      setStatus(response.data.status);
      setPhoneNumber(response.data.phoneNumber || '');
      setLastUpdate(new Date());
      
      if (response.data.status === 'pending_qr') {
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
  }, [currentBusiness]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleCreate = async () => {
    if (!currentBusiness) return;
    
    setLoading(true);
    setError('');
    
    try {
      await waApi.create(currentBusiness.id);
      const refreshed = await businessApi.get(currentBusiness.id);
      setCurrentBusiness(refreshed.data);
      await fetchStatus();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al crear instancia');
    } finally {
      setLoading(false);
    }
  };

  const handleRefreshQR = async () => {
    if (!currentBusiness) return;
    
    setActionLoading('qr');
    setError('');
    
    try {
      const qrResponse = await waApi.qr(currentBusiness.id);
      setQrCode(qrResponse.data.qr || '');
      setLastUpdate(new Date());
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al obtener QR');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRestart = async () => {
    if (!currentBusiness) return;
    
    setActionLoading('restart');
    setError('');
    
    try {
      await waApi.restart(currentBusiness.id);
      await fetchStatus();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al reiniciar');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    if (!currentBusiness) return;
    if (!confirm('¿Estás seguro de eliminar la conexión de WhatsApp? Tendrás que escanear el código QR de nuevo.')) return;
    
    setActionLoading('delete');
    setError('');
    
    try {
      await waApi.delete(currentBusiness.id);
      const refreshed = await businessApi.get(currentBusiness.id);
      setCurrentBusiness(refreshed.data);
      setStatus('not_created');
      setQrCode('');
      setPhoneNumber('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al eliminar');
    } finally {
      setActionLoading(null);
    }
  };

  const getStatusBadge = () => {
    const badges: Record<string, { color: string; text: string }> = {
      'not_created': { color: 'bg-gray-100 text-gray-600', text: 'Sin configurar' },
      'pending_qr': { color: 'bg-yellow-100 text-yellow-700', text: 'Esperando QR' },
      'open': { color: 'bg-green-100 text-green-700', text: 'Conectado' },
      'closed': { color: 'bg-red-100 text-red-700', text: 'Desconectado' },
      'connecting': { color: 'bg-blue-100 text-blue-700', text: 'Conectando...' }
    };
    const badge = badges[status] || { color: 'bg-gray-100 text-gray-600', text: status };
    return (
      <span className={`px-3 py-1 rounded-full text-sm font-medium ${badge.color}`}>
        {badge.text}
      </span>
    );
  };

  if (!currentBusiness) {
    return (
      <div className="card text-center py-12">
        <p className="text-gray-600">
          Primero debes crear una empresa para conectar WhatsApp.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">WhatsApp</h1>
        {status !== 'not_created' && getStatusBadge()}
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg mb-4 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-400 hover:text-red-600">
            ✕
          </button>
        </div>
      )}

      <div className="card">
        {status === 'not_created' && (
          <div className="text-center py-8">
            <div className="text-6xl mb-4">💬</div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              Conecta tu WhatsApp
            </h2>
            <p className="text-gray-600 mb-6">
              Crea una instancia de WhatsApp para empezar a recibir mensajes.
            </p>
            <button
              onClick={handleCreate}
              disabled={loading}
              className="btn btn-primary"
            >
              {loading ? 'Creando...' : 'Crear instancia'}
            </button>
          </div>
        )}

        {status === 'pending_qr' && (
          <div className="py-6">
            <div className="text-center mb-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-2">
                Escanea el código QR
              </h2>
              <p className="text-gray-600 text-sm">
                Abre WhatsApp en tu teléfono → Menú → Dispositivos vinculados → Vincular dispositivo
              </p>
            </div>
            
            <div className="flex justify-center mb-6">
              {qrCode ? (
                <div className="relative inline-block p-4 bg-white rounded-lg shadow-sm border">
                  <img
                    src={qrCode}
                    alt="QR Code"
                    className="w-64 h-64"
                  />
                  {actionLoading === 'qr' && (
                    <div className="absolute inset-0 bg-white/80 flex items-center justify-center rounded-lg">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600"></div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="w-64 h-64 bg-gray-100 rounded-lg flex items-center justify-center border">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600"></div>
                </div>
              )}
            </div>

            {lastUpdate && (
              <p className="text-center text-xs text-gray-400 mb-4">
                Última actualización: {lastUpdate.toLocaleTimeString()}
              </p>
            )}

            <div className="flex flex-wrap justify-center gap-3">
              <button
                onClick={handleRefreshQR}
                disabled={actionLoading !== null}
                className="btn btn-secondary flex items-center gap-2"
              >
                <span>🔄</span>
                {actionLoading === 'qr' ? 'Obteniendo...' : 'Refrescar QR'}
              </button>
              <button
                onClick={handleRestart}
                disabled={actionLoading !== null}
                className="btn btn-secondary flex items-center gap-2"
              >
                <span>🔁</span>
                {actionLoading === 'restart' ? 'Reiniciando...' : 'Reiniciar'}
              </button>
              <button
                onClick={handleDelete}
                disabled={actionLoading !== null}
                className="btn btn-danger flex items-center gap-2"
              >
                <span>🗑️</span>
                {actionLoading === 'delete' ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>

            <div className="mt-6 p-4 bg-blue-50 rounded-lg">
              <p className="text-sm text-blue-700">
                <strong>¿Problemas con el QR?</strong><br/>
                • Si el QR no carga, haz clic en "Refrescar QR"<br/>
                • Si el QR expiró, haz clic en "Reiniciar" para generar uno nuevo<br/>
                • Si hay errores persistentes, elimina y vuelve a crear la instancia
              </p>
            </div>
          </div>
        )}

        {status === 'open' && (
          <div className="py-6">
            <div className="flex items-center gap-4 mb-6 p-4 bg-green-50 rounded-lg">
              <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                <span className="text-3xl">✓</span>
              </div>
              <div>
                <h2 className="text-xl font-semibold text-gray-900">WhatsApp Conectado</h2>
                {phoneNumber && (
                  <p className="text-green-700 font-medium">+{phoneNumber}</p>
                )}
                <p className="text-sm text-gray-500">Tu cuenta está activa y recibiendo mensajes</p>
              </div>
            </div>
            
            <div className="border-t pt-6">
              <h3 className="text-sm font-medium text-gray-700 mb-3">Acciones de la conexión:</h3>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={handleRestart}
                  disabled={actionLoading !== null}
                  className="btn btn-secondary flex items-center gap-2"
                >
                  <span>🔁</span>
                  {actionLoading === 'restart' ? 'Reiniciando...' : 'Reiniciar conexión'}
                </button>
                <button
                  onClick={handleDelete}
                  disabled={actionLoading !== null}
                  className="btn btn-danger flex items-center gap-2"
                >
                  <span>🗑️</span>
                  {actionLoading === 'delete' ? 'Eliminando...' : 'Eliminar instancia'}
                </button>
              </div>
            </div>

            <div className="mt-6 p-4 bg-gray-50 rounded-lg">
              <p className="text-sm text-gray-600">
                <strong>Nota:</strong> Si deseas cambiar de número de WhatsApp, primero elimina esta instancia y luego crea una nueva escaneando el código QR con el otro teléfono.
              </p>
            </div>
          </div>
        )}

        {status === 'closed' && (
          <div className="py-6">
            <div className="text-center mb-6">
              <div className="text-6xl mb-4">⚠️</div>
              <h2 className="text-xl font-semibold text-gray-900 mb-2">
                Conexión perdida
              </h2>
              <p className="text-gray-600">
                La conexión con WhatsApp se ha cerrado. Esto puede pasar si cerraste la sesión desde tu teléfono.
              </p>
            </div>

            <div className="flex flex-wrap justify-center gap-3">
              <button
                onClick={handleRestart}
                disabled={actionLoading !== null}
                className="btn btn-primary flex items-center gap-2"
              >
                <span>🔁</span>
                {actionLoading === 'restart' ? 'Reconectando...' : 'Reconectar'}
              </button>
              <button
                onClick={handleDelete}
                disabled={actionLoading !== null}
                className="btn btn-danger flex items-center gap-2"
              >
                <span>🗑️</span>
                {actionLoading === 'delete' ? 'Eliminando...' : 'Eliminar y empezar de nuevo'}
              </button>
            </div>

            <div className="mt-6 p-4 bg-yellow-50 rounded-lg">
              <p className="text-sm text-yellow-700">
                <strong>Consejo:</strong> Si la reconexión no funciona, elimina la instancia y vuelve a escanear el código QR desde tu teléfono.
              </p>
            </div>
          </div>
        )}

        {status === 'connecting' && (
          <div className="text-center py-8">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mx-auto mb-4"></div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              Conectando...
            </h2>
            <p className="text-gray-600 text-sm">
              Estableciendo conexión con WhatsApp
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

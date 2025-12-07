'use client';

import { useState, useEffect, useCallback } from 'react';
import { useBusinessStore } from '@/store/business';
import { waApi, businessApi } from '@/lib/api';

export default function WhatsAppPage() {
  const { currentBusiness, setCurrentBusiness } = useBusinessStore();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [qrCode, setQrCode] = useState<string>('');
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [error, setError] = useState('');

  const fetchStatus = useCallback(async () => {
    if (!currentBusiness) return;
    
    try {
      const response = await waApi.status(currentBusiness.id);
      setStatus(response.data.status);
      setPhoneNumber(response.data.phoneNumber || '');
      
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

  const handleRestart = async () => {
    if (!currentBusiness) return;
    
    setLoading(true);
    setError('');
    
    try {
      await waApi.restart(currentBusiness.id);
      await fetchStatus();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al reiniciar');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!currentBusiness) return;
    if (!confirm('¿Estás seguro de eliminar la conexión de WhatsApp?')) return;
    
    setLoading(true);
    
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
      setLoading(false);
    }
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
      <h1 className="text-2xl font-bold text-gray-900 mb-6">WhatsApp</h1>

      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg mb-4">
          {error}
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
          <div className="text-center py-8">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              Escanea el código QR
            </h2>
            {qrCode ? (
              <div className="inline-block p-4 bg-white rounded-lg shadow-sm mb-4">
                <img
                  src={qrCode}
                  alt="QR Code"
                  className="w-64 h-64"
                />
              </div>
            ) : (
              <div className="w-64 h-64 mx-auto bg-gray-100 rounded-lg flex items-center justify-center mb-4">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600"></div>
              </div>
            )}
            <p className="text-gray-600 text-sm">
              Abre WhatsApp en tu teléfono y escanea este código
            </p>
          </div>
        )}

        {status === 'open' && (
          <div className="py-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
                <span className="text-2xl">✓</span>
              </div>
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Conectado</h2>
                {phoneNumber && (
                  <p className="text-gray-600">+{phoneNumber}</p>
                )}
              </div>
            </div>
            
            <div className="flex gap-3">
              <button
                onClick={handleRestart}
                disabled={loading}
                className="btn btn-secondary"
              >
                Reiniciar conexión
              </button>
              <button
                onClick={handleDelete}
                disabled={loading}
                className="btn btn-danger"
              >
                Eliminar instancia
              </button>
            </div>
          </div>
        )}

        {status === 'closed' && (
          <div className="text-center py-8">
            <div className="text-6xl mb-4">⚠️</div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              Conexión cerrada
            </h2>
            <p className="text-gray-600 mb-6">
              La conexión con WhatsApp se ha perdido.
            </p>
            <button
              onClick={handleRestart}
              disabled={loading}
              className="btn btn-primary"
            >
              {loading ? 'Reiniciando...' : 'Reconectar'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { waApi } from '@/lib/api';

interface StepWhatsAppProps {
  businessId: string;
  onComplete: () => void;
  onSkip: () => void;
}

type ProviderType = 'BAILEYS' | 'META';

export default function StepWhatsApp({ businessId, onComplete, onSkip }: StepWhatsAppProps) {
  const [provider, setProvider] = useState<ProviderType | null>(null);
  const [qrCode, setQrCode] = useState<string>('');
  const [status, setStatus] = useState<'choosing' | 'loading' | 'pending_qr' | 'connected' | 'error' | 'not_created'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await waApi.status(businessId);
      const newStatus = response.data.status;
      
      setStatus(newStatus === 'open' || newStatus === 'connected' ? 'connected' : 
                newStatus === 'pending_qr' ? 'pending_qr' : 
                newStatus === 'not_created' ? 'not_created' : 'pending_qr');
      setProvider(response.data.provider || 'BAILEYS');
      setPhoneNumber(response.data.phoneNumber || '');
      
      if (newStatus === 'open' || newStatus === 'connected') {
        setTimeout(onComplete, 1500);
        return;
      }
      
      if (newStatus === 'pending_qr' && response.data.provider !== 'META_CLOUD') {
        const qrResponse = await waApi.qr(businessId);
        setQrCode(qrResponse.data.qr || '');
      }
    } catch (err: any) {
      if (err.response?.status === 404) {
        setStatus('choosing');
      } else {
        console.error('Error fetching status:', err);
      }
    }
  }, [businessId, onComplete]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (status !== 'pending_qr' && status !== 'connected') return;
    
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [status, fetchStatus]);

  const handleProviderSelect = async (selectedProvider: ProviderType) => {
    setProvider(selectedProvider);
    
    if (selectedProvider === 'META') {
      setStatus('pending_qr');
      return;
    }
    
    await createBaileysInstance();
  };

  const createBaileysInstance = async () => {
    try {
      setStatus('loading');
      setErrorMessage(null);
      
      await waApi.create(businessId);
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      await fetchStatus();
    } catch (error: any) {
      console.error('Error creating instance:', error);
      setStatus('error');
      setErrorMessage(error.response?.data?.error || 'Error al crear la instancia');
    }
  };

  const handleRefreshQR = async () => {
    setActionLoading('qr');
    setErrorMessage(null);
    
    try {
      const qrResponse = await waApi.qr(businessId);
      setQrCode(qrResponse.data.qr || '');
    } catch (err: any) {
      setErrorMessage(err.response?.data?.error || 'Error al obtener QR');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRestart = async () => {
    setActionLoading('restart');
    setErrorMessage(null);
    
    try {
      await waApi.restart(businessId);
      await new Promise(resolve => setTimeout(resolve, 2000));
      await fetchStatus();
    } catch (error: any) {
      console.error('Error restarting instance:', error);
      setErrorMessage('Error al reiniciar. Intenta de nuevo.');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Eliminar conexion de WhatsApp? Tendras que configurar de nuevo.')) return;
    
    setActionLoading('delete');
    setErrorMessage(null);
    
    try {
      await waApi.delete(businessId);
      setStatus('choosing');
      setQrCode('');
      setPhoneNumber('');
      setProvider(null);
    } catch (error: any) {
      console.error('Error deleting instance:', error);
      setErrorMessage('Error al eliminar. Intenta de nuevo.');
    } finally {
      setActionLoading(null);
    }
  };

  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 sm:h-12 sm:w-12 border-b-2 border-white mx-auto mb-3"></div>
          <p className="text-gray-400 text-sm">Verificando estado...</p>
        </div>
      </div>
    );
  }

  if (status === 'choosing' || status === 'not_created') {
    return (
      <div className="text-center">
        <h2 className="text-lg sm:text-xl font-semibold text-white mb-2">Elige como conectar WhatsApp</h2>
        <p className="text-gray-400 text-xs sm:text-sm mb-6">Selecciona el metodo que mejor se adapte a tu negocio</p>

        <div className="grid gap-4 max-w-lg mx-auto">
          <button
            onClick={() => handleProviderSelect('BAILEYS')}
            className="bg-[#25D366]/10 hover:bg-[#25D366]/20 border border-[#25D366]/30 rounded-xl p-4 text-left transition group"
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl sm:text-3xl">📱</span>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-white text-sm sm:text-base">Codigo QR (Rapido)</h3>
                <p className="text-gray-400 text-xs sm:text-sm mt-1">
                  Escanea un codigo QR con tu telefono personal. Ideal para empezar rapido.
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <span className="text-[10px] sm:text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded">
                    Menos estable a alto volumen
                  </span>
                  <span className="text-[10px] sm:text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded">
                    Sin costo extra
                  </span>
                </div>
              </div>
            </div>
          </button>

          <button
            onClick={() => handleProviderSelect('META')}
            className="bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 rounded-xl p-4 text-left transition group"
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl sm:text-3xl">☁️</span>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-white text-sm sm:text-base">Meta Cloud API (Profesional)</h3>
                <p className="text-gray-400 text-xs sm:text-sm mt-1">
                  API oficial de Meta/WhatsApp Business. Estable para +50 conversaciones diarias.
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <span className="text-[10px] sm:text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">
                    100% estable
                  </span>
                  <span className="text-[10px] sm:text-xs bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded">
                    Requiere cuenta Business
                  </span>
                </div>
              </div>
            </div>
          </button>
        </div>

        <p className="text-gray-500 text-[10px] sm:text-xs mt-6 max-w-md mx-auto">
          Puedes cambiar el metodo de conexion despues en la seccion de WhatsApp
        </p>
      </div>
    );
  }

  if (provider === 'META' && status === 'pending_qr') {
    return (
      <div className="text-center">
        <h2 className="text-lg sm:text-xl font-semibold text-white mb-2">Meta Cloud API</h2>
        <p className="text-gray-400 text-xs sm:text-sm mb-6">
          La configuracion de Meta Cloud API requiere pasos adicionales
        </p>

        <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4 sm:p-6 max-w-md mx-auto text-left">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-3xl">☁️</span>
            <div>
              <h3 className="font-semibold text-white text-sm sm:text-base">Configuracion avanzada</h3>
              <p className="text-gray-400 text-xs">Puedes configurarlo desde el panel</p>
            </div>
          </div>
          
          <ul className="text-gray-300 text-xs sm:text-sm space-y-2 mb-4">
            <li className="flex items-start gap-2">
              <span className="text-blue-400">1.</span>
              <span>Necesitas una cuenta de Meta Business</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-blue-400">2.</span>
              <span>Configurar App de WhatsApp en developers.facebook.com</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-blue-400">3.</span>
              <span>Obtener Access Token y Phone Number ID</span>
            </li>
          </ul>

          <button
            onClick={onSkip}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2 text-sm font-medium transition"
          >
            Continuar y configurar despues
          </button>
        </div>

        <button
          onClick={() => setStatus('choosing')}
          className="mt-4 text-gray-400 hover:text-white text-xs sm:text-sm transition"
        >
          ← Volver a elegir metodo
        </button>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="text-center py-8">
        <div className="w-48 h-48 sm:w-64 sm:h-64 mx-auto bg-red-500/10 rounded-xl flex flex-col items-center justify-center p-4">
          <span className="text-3xl sm:text-4xl mb-3">⚠️</span>
          <p className="text-red-400 text-xs sm:text-sm text-center mb-3">{errorMessage}</p>
          <button
            onClick={createBaileysInstance}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-xs sm:text-sm hover:bg-indigo-700 transition"
          >
            Reintentar
          </button>
        </div>
        <button
          onClick={() => setStatus('choosing')}
          className="mt-4 text-gray-400 hover:text-white text-xs sm:text-sm transition"
        >
          ← Volver a elegir metodo
        </button>
      </div>
    );
  }

  if (status === 'connected') {
    return (
      <div className="text-center py-4">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="w-48 h-48 sm:w-64 sm:h-64 mx-auto bg-[#25D366]/20 rounded-xl flex flex-col items-center justify-center"
        >
          <span className="text-5xl sm:text-6xl mb-3">✅</span>
          <p className="text-[#25D366] font-semibold text-sm sm:text-base">¡WhatsApp conectado!</p>
          {phoneNumber && (
            <p className="text-gray-400 text-xs mt-1">+{phoneNumber}</p>
          )}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="text-center">
      <h2 className="text-lg sm:text-xl font-semibold text-white mb-1">Escanea el codigo QR</h2>
      <p className="text-gray-400 text-xs sm:text-sm mb-4">Abre WhatsApp en tu telefono y escanea</p>

      {errorMessage && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-lg mb-4 text-xs sm:text-sm">
          {errorMessage}
        </div>
      )}

      <div className="flex justify-center mb-4">
        {qrCode ? (
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="relative p-2 bg-white rounded-xl"
          >
            <img src={qrCode} alt="QR Code" className="w-44 h-44 sm:w-52 sm:h-52" />
            {actionLoading === 'qr' && (
              <div className="absolute inset-0 bg-white/80 flex items-center justify-center rounded-xl">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
              </div>
            )}
          </motion.div>
        ) : (
          <div className="w-44 h-44 sm:w-52 sm:h-52 bg-gray-800 rounded-xl flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-2"></div>
              <p className="text-gray-400 text-xs">Generando QR...</p>
            </div>
          </div>
        )}
      </div>

      <div className="bg-gray-800/50 rounded-lg p-3 sm:p-4 max-w-sm mx-auto mb-4">
        <p className="text-white text-xs sm:text-sm font-medium mb-2">Como escanear:</p>
        <ol className="text-gray-400 text-[10px] sm:text-xs text-left space-y-1">
          <li>1. Abre WhatsApp en tu telefono</li>
          <li>2. Toca Menu → Dispositivos vinculados</li>
          <li>3. Toca "Vincular dispositivo" y escanea</li>
        </ol>
      </div>

      <div className="flex flex-wrap justify-center gap-2">
        <button
          onClick={handleRefreshQR}
          disabled={actionLoading !== null}
          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-xs sm:text-sm transition flex items-center gap-1 disabled:opacity-50"
        >
          {actionLoading === 'qr' ? (
            <span className="animate-spin">↻</span>
          ) : (
            <svg className="w-3 h-3 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          )}
          Refrescar QR
        </button>
        <button
          onClick={handleRestart}
          disabled={actionLoading !== null}
          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-xs sm:text-sm transition disabled:opacity-50"
        >
          {actionLoading === 'restart' ? '...' : 'Reiniciar'}
        </button>
        <button
          onClick={handleDelete}
          disabled={actionLoading !== null}
          className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-lg text-xs sm:text-sm transition disabled:opacity-50"
        >
          {actionLoading === 'delete' ? '...' : 'Eliminar'}
        </button>
      </div>

      <button
        onClick={() => setStatus('choosing')}
        className="mt-4 text-gray-500 hover:text-gray-300 text-xs transition"
      >
        Cambiar metodo de conexion
      </button>
    </div>
  );
}

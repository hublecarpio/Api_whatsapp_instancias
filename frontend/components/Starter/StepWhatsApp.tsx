'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { waApi } from '@/lib/api';
import { QRCodeSVG } from 'qrcode.react';

interface StepWhatsAppProps {
  businessId: string;
  onComplete: () => void;
  onSkip: () => void;
}

export default function StepWhatsApp({ businessId, onComplete, onSkip }: StepWhatsAppProps) {
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'pending_qr' | 'connected' | 'error'>('loading');
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    initInstance();
  }, [businessId]);

  useEffect(() => {
    if (!instanceId || status === 'connected') return;

    const interval = setInterval(async () => {
      try {
        const response = await waApi.instances(businessId);
        const instance = response.data.find((i: any) => i.id === instanceId);
        
        if (instance?.status === 'connected') {
          setStatus('connected');
          clearInterval(interval);
          setTimeout(onComplete, 1500);
        } else if (instance?.qr) {
          setQrCode(instance.qr);
          setStatus('pending_qr');
        }
      } catch (error) {
        console.error('Error polling instance:', error);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [instanceId, status, onComplete, businessId]);

  const initInstance = async () => {
    try {
      setStatus('loading');
      setErrorMessage(null);
      
      const existingResponse = await waApi.instances(businessId);
      const existing = existingResponse.data.find((i: any) => i.provider === 'BAILEYS');
      
      if (existing) {
        setInstanceId(existing.id);
        if (existing.status === 'connected') {
          setStatus('connected');
          setTimeout(onComplete, 500);
          return;
        }
        if (existing.qr) {
          setQrCode(existing.qr);
          setStatus('pending_qr');
          return;
        }
      }
      
      const response = await waApi.create(businessId);
      
      setInstanceId(response.data.id);
      if (response.data.qr) {
        setQrCode(response.data.qr);
        setStatus('pending_qr');
      }
    } catch (error: any) {
      console.error('Error creating instance:', error);
      setStatus('error');
      setErrorMessage(error.response?.data?.error || 'Error al crear la instancia');
    }
  };

  return (
    <div className="text-center">
      <h2 className="text-xl font-semibold text-white mb-2">Conecta tu WhatsApp</h2>
      <p className="text-gray-400 mb-6">Escanea el código QR con tu teléfono para vincular tu número</p>

      <div className="flex justify-center mb-6">
        {status === 'loading' && (
          <div className="w-64 h-64 bg-gray-800 rounded-xl flex items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white"></div>
          </div>
        )}

        {status === 'pending_qr' && qrCode && (
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white p-4 rounded-xl"
          >
            <QRCodeSVG value={qrCode} size={220} />
          </motion.div>
        )}

        {status === 'connected' && (
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-64 h-64 bg-[#25D366]/20 rounded-xl flex flex-col items-center justify-center"
          >
            <span className="text-6xl mb-4">✅</span>
            <p className="text-[#25D366] font-semibold">¡WhatsApp conectado!</p>
          </motion.div>
        )}

        {status === 'error' && (
          <div className="w-64 h-64 bg-red-500/10 rounded-xl flex flex-col items-center justify-center p-4">
            <span className="text-4xl mb-4">⚠️</span>
            <p className="text-red-400 text-sm text-center">{errorMessage}</p>
            <button
              onClick={initInstance}
              className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 transition"
            >
              Reintentar
            </button>
          </div>
        )}
      </div>

      {status === 'pending_qr' && (
        <div className="text-gray-500 text-sm">
          <p>1. Abre WhatsApp en tu teléfono</p>
          <p>2. Toca Menú o Configuración → Dispositivos vinculados</p>
          <p>3. Toca "Vincular un dispositivo" y escanea el código</p>
        </div>
      )}
    </div>
  );
}

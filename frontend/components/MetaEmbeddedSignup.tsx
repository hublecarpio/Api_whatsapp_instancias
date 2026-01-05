'use client';

import { useState, useEffect, useCallback } from 'react';
import { waApi } from '@/lib/api';

declare global {
  interface Window {
    FB: any;
    fbAsyncInit: () => void;
  }
}

interface MetaEmbeddedSignupProps {
  businessId: string;
  onSuccess: (instance: any) => void;
  onError: (error: string) => void;
  onCancel: () => void;
}

export default function MetaEmbeddedSignup({
  businessId,
  onSuccess,
  onError,
  onCancel
}: MetaEmbeddedSignupProps) {
  const [loading, setLoading] = useState(true);
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const [config, setConfig] = useState<{ appId: string; configId: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await waApi.getEmbeddedSignupConfig();
        setConfig(response.data);
        setLoading(false);
      } catch (err: any) {
        const errorMsg = err.response?.data?.error || 'Error al cargar configuracion';
        setError(errorMsg);
        setLoading(false);
        onError(errorMsg);
      }
    };

    fetchConfig();
  }, [onError]);

  useEffect(() => {
    if (!config?.appId) return;

    const loadFacebookSDK = () => {
      if (document.getElementById('facebook-jssdk')) {
        if (window.FB) {
          window.FB.init({
            appId: config.appId,
            cookie: true,
            xfbml: true,
            version: 'v21.0'
          });
          setSdkLoaded(true);
        }
        return;
      }

      window.fbAsyncInit = function() {
        window.FB.init({
          appId: config.appId,
          cookie: true,
          xfbml: true,
          version: 'v21.0'
        });
        setSdkLoaded(true);
      };

      const script = document.createElement('script');
      script.id = 'facebook-jssdk';
      script.src = 'https://connect.facebook.net/en_US/sdk.js';
      script.async = true;
      script.defer = true;
      document.body.appendChild(script);
    };

    loadFacebookSDK();
  }, [config?.appId]);

  const handleEmbeddedSignup = useCallback(() => {
    if (!window.FB || !config) {
      setError('Facebook SDK no esta cargado');
      return;
    }

    setConnecting(true);
    setError('');

    window.FB.login(
      async (response: any) => {
        if (response.authResponse) {
          const { code } = response.authResponse;
          const wabaId = response.authResponse.waba_id;
          const phoneNumberId = response.authResponse.phone_number_id;

          if (!code || !wabaId || !phoneNumberId) {
            setError('No se recibieron todos los datos necesarios de Meta');
            setConnecting(false);
            return;
          }

          try {
            const result = await waApi.completeEmbeddedSignup({
              businessId,
              code,
              wabaId,
              phoneNumberId
            });

            if (result.data.success) {
              onSuccess(result.data.instance);
            } else {
              throw new Error(result.data.error || 'Error al completar registro');
            }
          } catch (err: any) {
            const errorMsg = err.response?.data?.error || err.message || 'Error al conectar';
            setError(errorMsg);
            onError(errorMsg);
          }
        } else {
          setError('Autorizacion cancelada o fallida');
        }
        setConnecting(false);
      },
      {
        config_id: config.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          sessionInfoVersion: 2
        }
      }
    );
  }, [config, businessId, onSuccess, onError]);

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-neon-blue mx-auto mb-2"></div>
        <p className="text-gray-400 text-sm">Cargando configuracion...</p>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
        <p className="text-red-400 text-sm text-center">
          {error || 'No se pudo cargar la configuracion de Meta'}
        </p>
        <button
          onClick={onCancel}
          className="mt-3 w-full px-4 py-2 bg-dark-surface border border-dark-border rounded-lg hover:bg-dark-hover transition-colors text-sm"
        >
          Cancelar
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="p-4 bg-neon-blue/10 border border-neon-blue/30 rounded-lg">
        <h4 className="font-medium text-white mb-2 flex items-center gap-2">
          <span className="text-xl">☁️</span>
          Meta Cloud API - Embedded Signup
        </h4>
        <p className="text-sm text-gray-300 mb-3">
          Conecta tu numero de WhatsApp Business existente usando el flujo oficial de Meta.
          Meta manejara la verificacion y vinculacion de tu numero.
        </p>
        <ul className="text-xs text-gray-400 space-y-1 mb-4">
          <li>• Tu numero debe estar activo en WhatsApp Business App</li>
          <li>• Meta te pedira confirmar desde tu telefono o con QR</li>
          <li>• Podras seguir usando la App y la API simultaneamente</li>
        </ul>
      </div>

      {error && (
        <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-sm text-center">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onCancel}
          className="flex-1 px-4 py-2 bg-dark-surface border border-dark-border rounded-lg hover:bg-dark-hover transition-colors"
        >
          Cancelar
        </button>
        <button
          onClick={handleEmbeddedSignup}
          disabled={!sdkLoaded || connecting}
          className="flex-1 bg-[#1877F2] hover:bg-[#166FE5] text-white px-4 py-3 rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2 font-medium"
        >
          {connecting ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
              Conectando...
            </>
          ) : !sdkLoaded ? (
            'Cargando SDK...'
          ) : (
            <>
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
              </svg>
              Conectar con Facebook
            </>
          )}
        </button>
      </div>
    </div>
  );
}

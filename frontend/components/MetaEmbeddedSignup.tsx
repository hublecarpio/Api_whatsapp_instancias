'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { waApi } from '@/lib/api';

declare global {
  interface Window {
    FB: any;
    fbAsyncInit: () => void;
  }
}

interface MetaEmbeddedSignupProps {
  businessId: string;
  provider?: 'META_CLOUD' | 'META_COEXIST';
  onSuccess: (instance: any) => void;
  onError: (error: string) => void;
  onCancel: () => void;
}

interface SessionInfoData {
  waba_id?: string;
  phone_number_id?: string;
  business_id?: string;
}

export default function MetaEmbeddedSignup({
  businessId,
  provider = 'META_CLOUD',
  onSuccess,
  onError,
  onCancel
}: MetaEmbeddedSignupProps) {
  const [loading, setLoading] = useState(true);
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const [sdkError, setSdkError] = useState('');
  const [config, setConfig] = useState<{ appId: string; configId: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const connectingRef = useRef(false);
  const sdkTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const sessionInfoRef = useRef<SessionInfoData>({});

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') {
        return;
      }
      
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        console.log('[MetaEmbeddedSignup] Message from Meta:', data);
        
        if (data.type === 'WA_EMBEDDED_SIGNUP') {
          if (data.event === 'FINISH' || data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
            const sessionInfo = data.data;
            console.log('[MetaEmbeddedSignup] Session info received (event:', data.event, '):', sessionInfo);
            sessionInfoRef.current = {
              waba_id: sessionInfo.waba_id,
              phone_number_id: sessionInfo.phone_number_id,
              business_id: sessionInfo.business_id || sessionInfo.current_business_id
            };
          } else if (data.event === 'CANCEL') {
            console.log('[MetaEmbeddedSignup] User cancelled embedded signup');
          } else if (data.event === 'ERROR') {
            console.error('[MetaEmbeddedSignup] Embedded signup error:', data.data);
          }
        }
      } catch (e) {
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await waApi.getEmbeddedSignupConfig();
        console.log('[MetaEmbeddedSignup] Config loaded:', response.data);
        setConfig(response.data);
        setLoading(false);
      } catch (err: any) {
        const errorMsg = err.response?.data?.error || 'Error al cargar configuracion';
        console.error('[MetaEmbeddedSignup] Config error:', errorMsg);
        setError(errorMsg);
        setLoading(false);
        onError(errorMsg);
      }
    };

    fetchConfig();
  }, [onError]);

  useEffect(() => {
    if (!config?.appId) return;

    console.log('[MetaEmbeddedSignup] Loading Facebook SDK with appId:', config.appId);

    sdkTimeoutRef.current = setTimeout(() => {
      if (!sdkLoaded) {
        console.error('[MetaEmbeddedSignup] SDK timeout - failed to load');
        setSdkError('El SDK de Facebook no pudo cargarse. Verifica tu conexion e intenta de nuevo.');
      }
    }, 15000);

    const loadFacebookSDK = () => {
      if (document.getElementById('facebook-jssdk')) {
        console.log('[MetaEmbeddedSignup] SDK script exists, checking FB object');
        if (window.FB) {
          console.log('[MetaEmbeddedSignup] FB exists, reinitializing');
          window.FB.init({
            appId: config.appId,
            cookie: true,
            xfbml: true,
            version: 'v21.0'
          });
          setSdkLoaded(true);
          if (sdkTimeoutRef.current) clearTimeout(sdkTimeoutRef.current);
        } else {
          console.log('[MetaEmbeddedSignup] FB not ready, setting up fbAsyncInit');
          window.fbAsyncInit = function() {
            console.log('[MetaEmbeddedSignup] fbAsyncInit called');
            window.FB.init({
              appId: config.appId,
              cookie: true,
              xfbml: true,
              version: 'v21.0'
            });
            setSdkLoaded(true);
            if (sdkTimeoutRef.current) clearTimeout(sdkTimeoutRef.current);
          };
        }
        return;
      }

      window.fbAsyncInit = function() {
        console.log('[MetaEmbeddedSignup] fbAsyncInit called (new script)');
        window.FB.init({
          appId: config.appId,
          cookie: true,
          xfbml: true,
          version: 'v21.0'
        });
        setSdkLoaded(true);
        if (sdkTimeoutRef.current) clearTimeout(sdkTimeoutRef.current);
      };

      const script = document.createElement('script');
      script.id = 'facebook-jssdk';
      script.src = 'https://connect.facebook.net/en_US/sdk.js';
      script.async = true;
      script.defer = true;
      script.onload = () => console.log('[MetaEmbeddedSignup] SDK script loaded');
      script.onerror = () => {
        console.error('[MetaEmbeddedSignup] SDK script failed to load');
        setSdkError('No se pudo cargar el SDK de Facebook');
        if (sdkTimeoutRef.current) clearTimeout(sdkTimeoutRef.current);
      };
      document.body.appendChild(script);
    };

    loadFacebookSDK();

    return () => {
      if (sdkTimeoutRef.current) clearTimeout(sdkTimeoutRef.current);
    };
  }, [config?.appId, sdkLoaded]);

  const handleEmbeddedSignup = useCallback(() => {
    if (connectingRef.current) {
      console.log('[MetaEmbeddedSignup] Already connecting, ignoring click');
      return;
    }

    if (!window.FB) {
      console.error('[MetaEmbeddedSignup] FB object not available');
      setError('Facebook SDK no esta cargado. Recarga la pagina e intenta de nuevo.');
      return;
    }

    if (!config) {
      console.error('[MetaEmbeddedSignup] Config not available');
      setError('Configuracion no disponible');
      return;
    }

    console.log('[MetaEmbeddedSignup] Starting FB.login with config_id:', config.configId);
    connectingRef.current = true;
    setConnecting(true);
    setError('');

    try {
      window.FB.login(
        function(response: any) {
          console.log('[MetaEmbeddedSignup] FB.login response:', response);
          
          if (response.authResponse) {
            const { code } = response.authResponse;
            const wabaIdFromAuth = response.authResponse.waba_id;
            const phoneNumberIdFromAuth = response.authResponse.phone_number_id;
            
            const wabaId = wabaIdFromAuth || sessionInfoRef.current.waba_id;
            const phoneNumberId = phoneNumberIdFromAuth || sessionInfoRef.current.phone_number_id;

            const metaBusinessId = sessionInfoRef.current.business_id;

            console.log('[MetaEmbeddedSignup] Auth response data:', { 
              hasCode: !!code, 
              wabaId, 
              phoneNumberId,
              metaBusinessId,
              fromSessionInfo: !wabaIdFromAuth && !!sessionInfoRef.current.waba_id
            });

            if (!code) {
              setError('No se recibio el codigo de autorizacion de Meta.');
              connectingRef.current = false;
              setConnecting(false);
              return;
            }

            (async () => {
              try {
                console.log('[MetaEmbeddedSignup] Completing signup...');
                const result = await waApi.completeEmbeddedSignup({
                  businessId,
                  code,
                  wabaId: wabaId || undefined,
                  phoneNumberId: phoneNumberId || undefined,
                  metaBusinessId: metaBusinessId || undefined,
                  provider
                });

                console.log('[MetaEmbeddedSignup] Signup result:', result.data);

                if (result.data.success) {
                  onSuccess(result.data.instance);
                } else {
                  throw new Error(result.data.error || 'Error al completar registro');
                }
              } catch (err: any) {
                const errorMsg = err.response?.data?.error || err.message || 'Error al conectar';
                console.error('[MetaEmbeddedSignup] Signup error:', errorMsg);
                setError(errorMsg);
                onError(errorMsg);
              } finally {
                connectingRef.current = false;
                setConnecting(false);
                sessionInfoRef.current = {};
              }
            })();
          } else {
            console.log('[MetaEmbeddedSignup] No authResponse - user cancelled or error');
            if (response.status === 'unknown') {
              setError('La ventana de Facebook fue cerrada. Intenta de nuevo.');
            } else {
              setError('Autorizacion cancelada o fallida');
            }
            connectingRef.current = false;
            setConnecting(false);
          }
        },
        {
          config_id: config.configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: {
            featureType: 'whatsapp_business_app_onboarding',
            sessionInfoVersion: '3',
            version: 'v3'
          }
        }
      );
    } catch (err: any) {
      console.error('[MetaEmbeddedSignup] FB.login exception:', err);
      setError('Error al iniciar el flujo de Facebook: ' + (err.message || 'Error desconocido'));
      connectingRef.current = false;
      setConnecting(false);
    }
  }, [config, businessId, provider, onSuccess, onError]);

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

  const isCoexist = provider === 'META_COEXIST';
  
  return (
    <div className="space-y-4">
      <div className={`p-4 ${isCoexist ? 'bg-purple-500/10 border-purple-500/30' : 'bg-neon-blue/10 border-neon-blue/30'} border rounded-lg`}>
        <h4 className="font-medium text-white mb-2 flex items-center gap-2">
          <span className="text-xl">{isCoexist ? '🔗' : '☁️'}</span>
          {isCoexist ? 'Meta Coexistence - Embedded Signup' : 'Meta Cloud API - Embedded Signup'}
        </h4>
        <p className="text-sm text-gray-300 mb-3">
          {isCoexist 
            ? 'Conecta tu numero de WhatsApp Business App existente al API Cloud manteniendo el uso de la App.'
            : 'Conecta tu numero de WhatsApp Business existente usando el flujo oficial de Meta.'}
          {' '}Meta manejara la verificacion y vinculacion de tu numero.
        </p>
        <ul className="text-xs text-gray-400 space-y-1 mb-4">
          <li>• Tu numero debe estar activo en WhatsApp Business App</li>
          <li>• Meta te pedira confirmar desde tu telefono o escanear QR</li>
          <li>• {isCoexist 
            ? 'Podras usar la App y el API Cloud simultaneamente (Coexistence)'
            : 'Podras enviar y recibir mensajes via Cloud API'}
          </li>
        </ul>
      </div>

      {(error || sdkError) && (
        <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-sm text-center">
          {error || sdkError}
        </div>
      )}

      {sdkLoaded && (
        <div className="p-2 bg-green-500/10 border border-green-500/30 rounded-lg text-green-400 text-xs text-center">
          SDK de Facebook cargado correctamente
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onCancel}
          disabled={connecting}
          className="flex-1 px-4 py-2 bg-dark-surface border border-dark-border rounded-lg hover:bg-dark-hover transition-colors disabled:opacity-50"
        >
          Cancelar
        </button>
        <button
          onClick={handleEmbeddedSignup}
          disabled={!sdkLoaded || connecting || !!sdkError}
          className={`flex-1 ${isCoexist ? 'bg-purple-600 hover:bg-purple-700' : 'bg-[#1877F2] hover:bg-[#166FE5]'} text-white px-4 py-3 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-medium`}
        >
          {connecting ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
              Conectando...
            </>
          ) : !sdkLoaded ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
              Cargando SDK...
            </>
          ) : sdkError ? (
            'SDK no disponible'
          ) : (
            <>
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
              </svg>
              {isCoexist ? 'Conectar WhatsApp Business App' : 'Conectar con Facebook'}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthStore } from '@/store/auth';
import { authApi } from '@/lib/api';
import Logo from '@/components/Logo';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

function GoogleCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setAuth } = useAuthStore();
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'loading' | 'processing' | 'complete-profile' | 'error'>('loading');
  
  const [businessName, setBusinessName] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const token = searchParams.get('token');
    const isNew = searchParams.get('new') === 'true';
    const errorParam = searchParams.get('error');
    
    if (errorParam) {
      setError('Error al iniciar sesion con Google');
      setStatus('error');
      return;
    }
    
    if (token) {
      localStorage.setItem('token', token);
      
      authApi.getMe()
        .then(response => {
          setAuth(response.data, token);
          
          if (isNew) {
            setStatus('complete-profile');
          } else {
            if (response.data.role === 'ASESOR') {
              router.push('/asesor');
            } else {
              router.push('/dashboard');
            }
          }
        })
        .catch(err => {
          console.error('Error getting user:', err);
          setError('Error al obtener datos del usuario');
          setStatus('error');
        });
      return;
    }
    
    if (code && state) {
      setStatus('processing');
      
      fetch(`${API_URL}/auth/google/exchange`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code, state }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Error al procesar autenticacion');
          }
          return res.json();
        })
        .then((data) => {
          const { token: jwtToken, isNew: newUser } = data;
          localStorage.setItem('token', jwtToken);
          
          authApi.getMe()
            .then(response => {
              setAuth(response.data, jwtToken);
              
              if (newUser) {
                setStatus('complete-profile');
              } else {
                if (response.data.role === 'ASESOR') {
                  router.push('/asesor');
                } else {
                  router.push('/dashboard');
                }
              }
            })
            .catch(err => {
              console.error('Error getting user:', err);
              setError('Error al obtener datos del usuario');
              setStatus('error');
            });
        })
        .catch((err) => {
          console.error('Error exchanging code:', err);
          setError(err.message || 'Error al iniciar sesion con Google');
          setStatus('error');
        });
      return;
    }
    
    setError('Parametros de autenticacion no recibidos');
    setStatus('error');
  }, [searchParams, setAuth, router]);

  const handleCompleteProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    
    try {
      await authApi.updateProfile({ businessName, phone: phone || undefined });
      router.push('/dashboard');
    } catch (err) {
      console.error('Error updating profile:', err);
      router.push('/dashboard');
    }
  };

  if (status === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-bg p-4">
        <div className="max-w-md w-full text-center">
          <div className="flex justify-center mb-6">
            <Logo size="lg" />
          </div>
          <div className="card py-10">
            <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-white mb-3">Error de autenticacion</h2>
            <p className="text-gray-400 mb-6">{error}</p>
            <button
              onClick={() => router.push('/login')}
              className="btn btn-primary"
            >
              Volver al login
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'complete-profile') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-bg p-4">
        <div className="max-w-md w-full">
          <div className="text-center mb-8">
            <div className="flex justify-center mb-4">
              <Logo size="lg" />
            </div>
            <h1 className="text-xl font-semibold text-white">¡Bienvenido!</h1>
            <p className="text-gray-400 mt-2">Completa tu perfil para continuar</p>
          </div>

          <div className="card">
            <form onSubmit={handleCompleteProfile} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Nombre de tu negocio
                </label>
                <input
                  type="text"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  className="input"
                  placeholder="Mi Tienda Online"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Numero de WhatsApp <span className="text-gray-500">(opcional)</span>
                </label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="input"
                  placeholder="+51 999 888 777"
                />
                <p className="text-xs text-gray-500 mt-1">Para contactarte sobre tu cuenta</p>
              </div>

              <button
                type="submit"
                disabled={saving || !businessName}
                className="btn btn-primary w-full"
              >
                {saving ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Guardando...
                  </span>
                ) : (
                  'Continuar'
                )}
              </button>

              <button
                type="button"
                onClick={() => router.push('/dashboard')}
                className="w-full text-sm text-gray-400 hover:text-white transition-colors"
              >
                Omitir por ahora
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-bg p-4">
      <div className="text-center">
        <div className="flex justify-center mb-6">
          <Logo size="lg" />
        </div>
        <div className="w-8 h-8 border-2 border-neon-blue border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-gray-400">
          {status === 'processing' ? 'Procesando autenticacion...' : 'Iniciando sesion con Google...'}
        </p>
      </div>
    </div>
  );
}

export default function GoogleCallbackPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-dark-bg">
        <div className="w-8 h-8 border-2 border-neon-blue border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <GoogleCallbackContent />
    </Suspense>
  );
}

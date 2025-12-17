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
  const [status, setStatus] = useState<'loading' | 'processing' | 'error'>('loading');

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const token = searchParams.get('token');
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
          
          if (response.data.role === 'ASESOR') {
            router.push('/asesor');
          } else {
            router.push('/dashboard');
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
          const { token: jwtToken } = data;
          localStorage.setItem('token', jwtToken);
          
          authApi.getMe()
            .then(response => {
              setAuth(response.data, jwtToken);
              
              if (response.data.role === 'ASESOR') {
                router.push('/asesor');
              } else {
                router.push('/dashboard');
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

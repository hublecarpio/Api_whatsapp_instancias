'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Logo from '@/components/Logo';
import api from '@/lib/api';

export default function ReferralCodePage() {
  const params = useParams();
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [validCode, setValidCode] = useState(false);
  const code = params.code as string;

  useEffect(() => {
    const checkCode = async () => {
      try {
        const response = await api.get(`/auth/check-referral/${code}`);
        if (response.data.valid) {
          setValidCode(true);
          setTimeout(() => {
            router.push(`/register?code=${code.toUpperCase()}`);
          }, 1500);
        } else {
          setValidCode(false);
          setChecking(false);
        }
      } catch {
        setValidCode(false);
        setChecking(false);
      }
    };

    if (code) {
      checkCode();
    }
  }, [code, router]);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-bg p-4">
        <div className="max-w-md w-full text-center">
          <div className="flex justify-center mb-6">
            <Logo size="lg" />
          </div>
          <div className="card py-10">
            <div className="w-12 h-12 border-3 border-neon-blue border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-gray-400">Verificando codigo...</p>
          </div>
        </div>
      </div>
    );
  }

  if (validCode) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-bg p-4">
        <div className="max-w-md w-full text-center">
          <div className="flex justify-center mb-6">
            <Logo size="lg" />
          </div>
          <div className="card py-10">
            <div className="w-16 h-16 bg-accent-success/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-accent-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">Codigo valido</h2>
            <p className="text-gray-400">Redirigiendo al registro...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-bg p-4">
      <div className="max-w-md w-full text-center">
        <div className="flex justify-center mb-6">
          <Logo size="lg" />
        </div>
        <div className="card py-10">
          <div className="w-16 h-16 bg-accent-error/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-accent-error" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-white mb-2">Codigo no valido</h2>
          <p className="text-gray-400 mb-6">
            El codigo <span className="font-mono text-white">{code?.toUpperCase()}</span> no existe o ha expirado.
          </p>
          <button
            onClick={() => router.push('/register')}
            className="btn btn-primary"
          >
            Ir al registro
          </button>
        </div>
      </div>
    </div>
  );
}

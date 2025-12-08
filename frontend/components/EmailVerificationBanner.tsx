'use client';

import { useState } from 'react';
import { authApi } from '@/lib/api';

interface EmailVerificationBannerProps {
  email: string;
}

export default function EmailVerificationBanner({ email }: EmailVerificationBannerProps) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleResend = async () => {
    setSending(true);
    setError('');
    
    try {
      await authApi.resendVerification();
      setSent(true);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al enviar el correo');
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <div className="bg-accent-success/10 border border-accent-success/20 px-4 py-3 rounded-lg mb-4">
        <div className="flex items-center gap-3">
          <svg className="w-5 h-5 text-accent-success flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <p className="text-accent-success text-sm">
            Correo de verificación enviado a <strong>{email}</strong>. Revisa tu bandeja de entrada.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-accent-warning/10 border border-accent-warning/20 px-4 py-3 rounded-lg mb-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start sm:items-center gap-3">
          <svg className="w-5 h-5 text-accent-warning flex-shrink-0 mt-0.5 sm:mt-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <p className="text-white text-sm font-medium">Verifica tu correo electrónico</p>
            <p className="text-gray-400 text-xs mt-0.5">
              Para crear instancias de WhatsApp necesitas verificar tu email
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 ml-8 sm:ml-0">
          {error && <span className="text-accent-error text-xs">{error}</span>}
          <button
            onClick={handleResend}
            disabled={sending}
            className="btn btn-sm bg-accent-warning/20 text-accent-warning hover:bg-accent-warning/30 whitespace-nowrap"
          >
            {sending ? 'Enviando...' : 'Reenviar correo'}
          </button>
        </div>
      </div>
    </div>
  );
}

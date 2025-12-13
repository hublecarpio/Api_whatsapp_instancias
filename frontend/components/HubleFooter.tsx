'use client';

interface HubleFooterProps {
  variant?: 'full' | 'compact';
}

export default function HubleFooter({ variant = 'compact' }: HubleFooterProps) {
  if (variant === 'full') {
    return (
      <div className="bg-dark-surface border border-gray-700 rounded-lg p-6 text-center mt-6">
        <div className="flex items-center justify-center gap-2 mb-3">
          <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
          <span className="text-gray-400 text-sm font-medium">Operado por</span>
        </div>
        <h3 className="text-white text-lg font-semibold mb-2">Huble Consulting LLC</h3>
        <p className="text-gray-500 text-sm mb-4">
          Somos la empresa legal detras de este servicio. Todos los pagos son procesados de forma segura por Stripe a nombre de Huble Consulting LLC.
        </p>
        <a 
          href="https://hubleconsulting.com" 
          target="_blank" 
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-neon-blue hover:text-neon-blue/80 transition-colors text-sm"
        >
          <span>Visitar hubleconsulting.com</span>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>
    );
  }

  return (
    <div className="text-center py-4 mt-6 border-t border-gray-800">
      <p className="text-gray-500 text-xs">
        Operado por{' '}
        <a 
          href="https://hubleconsulting.com" 
          target="_blank" 
          rel="noopener noreferrer"
          className="text-gray-400 hover:text-neon-blue transition-colors"
        >
          Huble Consulting LLC
        </a>
      </p>
    </div>
  );
}

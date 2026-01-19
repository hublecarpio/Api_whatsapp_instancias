'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore, UserContext } from '@/store/auth';
import { useBusinessStore } from '@/store/business';
import { businessApi } from '@/lib/api';

export default function ContextSwitcher() {
  const router = useRouter();
  const { contexts, activeContext, setActiveContext } = useAuthStore();
  const { setCurrentBusiness } = useBusinessStore();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleContextSwitch = async (context: UserContext) => {
    setActiveContext(context);
    setIsOpen(false);
    
    // Load the business data for the new context
    try {
      const response = await businessApi.get(context.businessId);
      if (response.data) {
        setCurrentBusiness(response.data);
      }
    } catch (error) {
      console.error('Error loading business for context:', error);
    }
    
    // If switching to advisor role, navigate directly to chat (advisors only see assigned contacts)
    if (context.role === 'ADVISOR') {
      router.push('/dashboard/chat');
    } else {
      // For owner role, reload to refresh the dashboard
      window.location.href = '/dashboard/business';
    }
  };

  if (contexts.length <= 1) {
    return (
      <div className="px-4 py-3 border-b border-dark-border">
        <p className="text-xs text-gray-500 uppercase tracking-wider">Empresa</p>
        <p className="text-sm text-white font-medium truncate mt-1">
          {activeContext?.businessName || 'Sin negocio'}
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-b border-dark-border relative" ref={dropdownRef}>
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Empresa</p>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between text-left bg-dark-hover hover:bg-dark-border rounded-lg px-3 py-2 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {activeContext?.logoUrl ? (
            <img 
              src={activeContext.logoUrl} 
              alt="" 
              className="w-6 h-6 rounded-full object-cover flex-shrink-0"
            />
          ) : (
            <div className="w-6 h-6 rounded-full bg-neon-blue/20 flex items-center justify-center flex-shrink-0">
              <span className="text-neon-blue text-xs font-medium">
                {activeContext?.businessName?.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm text-white font-medium truncate">
              {activeContext?.businessName}
            </p>
            <p className="text-xs text-gray-500">
              {activeContext?.role === 'OWNER' ? 'Propietario' : 'Asesor'}
            </p>
          </div>
        </div>
        <svg 
          className={`w-4 h-4 text-gray-400 transition-transform flex-shrink-0 ${isOpen ? 'rotate-180' : ''}`} 
          fill="none" 
          stroke="currentColor" 
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute left-4 right-4 top-full mt-1 bg-dark-card border border-dark-border rounded-lg shadow-xl z-50 overflow-hidden">
          <div className="max-h-64 overflow-y-auto">
            {contexts.map((context) => (
              <button
                key={context.businessId}
                onClick={() => handleContextSwitch(context)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-dark-hover transition-colors ${
                  activeContext?.businessId === context.businessId ? 'bg-neon-blue/10' : ''
                }`}
              >
                {context.logoUrl ? (
                  <img 
                    src={context.logoUrl} 
                    alt="" 
                    className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-neon-blue/20 flex items-center justify-center flex-shrink-0">
                    <span className="text-neon-blue text-sm font-medium">
                      {context.businessName?.charAt(0).toUpperCase()}
                    </span>
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white font-medium truncate">
                    {context.businessName}
                  </p>
                  <p className="text-xs text-gray-500">
                    {context.role === 'OWNER' ? 'Propietario' : 'Asesor'}
                  </p>
                </div>
                {activeContext?.businessId === context.businessId && (
                  <svg className="w-4 h-4 text-neon-blue flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

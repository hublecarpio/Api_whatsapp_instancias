'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import TopBar from '@/components/TopBar';
import MobileDrawer from '@/components/MobileDrawer';
import PaymentGate from '@/components/PaymentGate';
import EmailVerificationBanner from '@/components/EmailVerificationBanner';
import { useAuthStore } from '@/store/auth';
import { useBusinessStore } from '@/store/business';
import { businessApi, authApi, billingApi } from '@/lib/api';

const AI_PREMIUM_PAGES = [
  '/dashboard/agent',
  '/dashboard/stages',
  '/dashboard/reminders',
  '/dashboard/follow-ups',
  '/dashboard/kanban'
];

export default function DashboardLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loadFromStorage, setAuth, updateUser, logout } = useAuthStore();
  const setBusinesses = useBusinessStore(state => state.setBusinesses);
  const setCurrentBusiness = useBusinessStore(state => state.setCurrentBusiness);
  const clearBusinesses = useBusinessStore(state => state.clearBusinesses);
  const [isReady, setIsReady] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [canAccess, setCanAccess] = useState(false);
  const [canUseCrm, setCanUseCrm] = useState(false);
  const [canUseAi, setCanUseAi] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [subscriptionStatus, setSubscriptionStatus] = useState('pending');
  const [trialDaysRemaining, setTrialDaysRemaining] = useState<number | null>(null);
  const initRef = useRef(false);

  const initializeDashboard = useCallback(async () => {
    if (initRef.current) return;
    initRef.current = true;

    loadFromStorage();
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const storedToken = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    
    if (!storedToken) {
      router.push('/login');
      return;
    }

    try {
      const accessResponse = await billingApi.getAccessStatus();
      const data = accessResponse.data;
      
      setCanAccess(data.canAccess);
      setCanUseCrm(data.canUseCrm);
      setCanUseAi(data.canUseAi);
      setEmailVerified(data.emailVerified);
      setSubscriptionStatus(data.subscriptionStatus);
      setTrialDaysRemaining(data.trialDaysRemaining);

      if (data.canUseCrm) {
        try {
          const [businessResponse, userResponse] = await Promise.all([
            businessApi.list(),
            authApi.me()
          ]);
          
          setBusinesses(businessResponse.data);
          if (businessResponse.data.length > 0) {
            setCurrentBusiness(businessResponse.data[0]);
          }
          
          if (userResponse.data) {
            setAuth(userResponse.data, storedToken);
          }
        } catch (dataError: any) {
          console.error('Failed to fetch protected data:', dataError);
          if (dataError.response?.status === 401) {
            logout();
            router.push('/login');
            return;
          }
        }
      } else {
        clearBusinesses();
      }
      
      setIsReady(true);
    } catch (error: any) {
      console.error('Failed to check access status:', error);
      
      if (error.response?.status === 401) {
        logout();
        router.push('/login');
        return;
      }
      
      setCanAccess(false);
      setCanUseCrm(false);
      setCanUseAi(false);
      setEmailVerified(false);
      setSubscriptionStatus('pending');
      clearBusinesses();
      setIsReady(true);
    }
  }, [loadFromStorage, router, setBusinesses, setCurrentBusiness, setAuth, clearBusinesses, logout]);

  useEffect(() => {
    const recheckAccess = async () => {
      if (!isReady) return;
      
      const storedToken = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
      if (!storedToken) return;
      
      try {
        const accessResponse = await billingApi.getAccessStatus();
        const data = accessResponse.data;
        
        setCanAccess(data.canAccess);
        setCanUseCrm(data.canUseCrm);
        setCanUseAi(data.canUseAi);
        setEmailVerified(data.emailVerified);
        setSubscriptionStatus(data.subscriptionStatus);
        setTrialDaysRemaining(data.trialDaysRemaining);
        
        if (data.canUseCrm && !canUseCrm) {
          try {
            const [businessResponse, userResponse] = await Promise.all([
              businessApi.list(),
              authApi.me()
            ]);
            
            setBusinesses(businessResponse.data);
            if (businessResponse.data.length > 0) {
              setCurrentBusiness(businessResponse.data[0]);
            }
            
            if (userResponse.data) {
              setAuth(userResponse.data, storedToken);
            }
          } catch (e) {
            console.error('Failed to reload data after access restored:', e);
          }
        } else if (!data.canUseCrm && canUseCrm) {
          clearBusinesses();
        }
      } catch (e) {
        console.error('Failed to recheck access:', e);
      }
    };

    recheckAccess();
  }, [pathname]);

  useEffect(() => {
    initializeDashboard();
  }, [initializeDashboard]);

  useEffect(() => {
    setMobileDrawerOpen(false);
  }, [pathname]);

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-bg">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-2 border-neon-blue border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">Cargando...</p>
        </div>
      </div>
    );
  }

  const isBillingPage = pathname === '/dashboard/billing';
  const isChatPage = pathname === '/dashboard/chat';
  const isWhatsAppPage = pathname === '/dashboard/whatsapp';
  const isAiPremiumPage = AI_PREMIUM_PAGES.some(page => pathname?.startsWith(page));
  
  const showEmailVerificationRequired = !emailVerified && !isBillingPage;
  const showPaymentGateForAi = isAiPremiumPage && !canUseAi && !isBillingPage;
  const showEmailBanner = user && user.emailVerified === false;

  return (
    <div className="flex min-h-screen bg-dark-bg">
      <div className="hidden sm:block">
        <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} transition-all duration-300 overflow-hidden`}>
          <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
        </div>
      </div>

      <TopBar onMenuClick={() => setMobileDrawerOpen(true)} />
      <MobileDrawer isOpen={mobileDrawerOpen} onClose={() => setMobileDrawerOpen(false)} />

      <main className={`flex-1 overflow-auto ${isChatPage ? 'p-0 sm:p-4' : 'p-4 sm:p-8'} pt-[calc(56px+1rem)] sm:pt-8`}>
        {showEmailVerificationRequired ? (
          <div className="min-h-[60vh] flex items-center justify-center p-4">
            <div className="card max-w-md w-full text-center">
              <div className="w-16 h-16 mx-auto mb-6 bg-neon-blue/10 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-neon-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-white mb-3">
                Verifica tu correo electronico
              </h2>
              <p className="text-gray-400 mb-6">
                Para acceder a las funciones de la plataforma, necesitas verificar tu correo electronico.
              </p>
              <EmailVerificationBanner email={user?.email || ''} />
            </div>
          </div>
        ) : showPaymentGateForAi ? (
          <PaymentGate 
            isOpen={true} 
            subscriptionStatus={subscriptionStatus}
            trialDaysRemaining={trialDaysRemaining}
          />
        ) : (
          <>
            {showEmailBanner && isWhatsAppPage && (
              <EmailVerificationBanner email={user?.email || ''} />
            )}
            {children}
          </>
        )}
      </main>
    </div>
  );
}

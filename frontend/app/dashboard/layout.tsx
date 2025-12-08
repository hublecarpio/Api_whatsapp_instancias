'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import PaymentGate from '@/components/PaymentGate';
import { useAuthStore } from '@/store/auth';
import { useBusinessStore } from '@/store/business';
import { businessApi, authApi, billingApi, setAccessBlocked, setOnAccessDenied } from '@/lib/api';

export default function DashboardLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { loadFromStorage, setAuth, logout } = useAuthStore();
  const setBusinesses = useBusinessStore(state => state.setBusinesses);
  const setCurrentBusiness = useBusinessStore(state => state.setCurrentBusiness);
  const clearBusinesses = useBusinessStore(state => state.clearBusinesses);
  const [isReady, setIsReady] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [canAccess, setCanAccess] = useState(false);
  const [subscriptionStatus, setSubscriptionStatus] = useState('pending');
  const [trialDaysRemaining, setTrialDaysRemaining] = useState<number | null>(null);
  const initRef = useRef(false);

  const handleAccessDenied = useCallback(() => {
    setCanAccess(false);
    setAccessBlocked(true);
    clearBusinesses();
  }, [clearBusinesses]);

  useEffect(() => {
    setOnAccessDenied(handleAccessDenied);
    return () => setOnAccessDenied(null);
  }, [handleAccessDenied]);

  const initializeDashboard = useCallback(async () => {
    if (initRef.current) return;
    initRef.current = true;

    loadFromStorage();
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const storedToken = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    
    if (!storedToken) {
      setIsReady(true);
      router.push('/login');
      return;
    }

    try {
      const accessResponse = await billingApi.getAccessStatus();
      const hasAccess = accessResponse.data.canAccess;
      
      setCanAccess(hasAccess);
      setSubscriptionStatus(accessResponse.data.subscriptionStatus);
      setTrialDaysRemaining(accessResponse.data.trialDaysRemaining);

      if (hasAccess) {
        setAccessBlocked(false);

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
          if (dataError.response?.status === 401) {
            logout();
            setIsReady(true);
            router.push('/login');
            return;
          }
        }
      } else {
        setAccessBlocked(true);
        clearBusinesses();
      }
      
      setIsReady(true);
    } catch (error: any) {
      setAccessBlocked(true);
      setCanAccess(false);
      setSubscriptionStatus(error.response?.data?.status || 'pending');
      clearBusinesses();
      
      if (error.response?.status === 401) {
        logout();
        setIsReady(true);
        router.push('/login');
        return;
      }
      
      setIsReady(true);
    }
  }, [loadFromStorage, router, setBusinesses, setCurrentBusiness, setAuth, clearBusinesses, logout]);

  useEffect(() => {
    const recheckAccess = async () => {
      const storedToken = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
      if (!storedToken) return;
      
      try {
        const accessResponse = await billingApi.getAccessStatus();
        const hasAccess = accessResponse.data.canAccess;
        
        if (hasAccess && !canAccess) {
          setAccessBlocked(false);
          setCanAccess(true);
          setSubscriptionStatus(accessResponse.data.subscriptionStatus);
          setTrialDaysRemaining(accessResponse.data.trialDaysRemaining);
          
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
        } else if (!hasAccess && canAccess) {
          setAccessBlocked(true);
          setCanAccess(false);
          clearBusinesses();
        }
        
        setSubscriptionStatus(accessResponse.data.subscriptionStatus);
        setTrialDaysRemaining(accessResponse.data.trialDaysRemaining);
      } catch (e) {
        console.error('Failed to recheck access:', e);
      }
    };

    if (isReady) {
      recheckAccess();
    }
  }, [pathname, isReady, canAccess, setBusinesses, setCurrentBusiness, setAuth, clearBusinesses]);

  useEffect(() => {
    initializeDashboard();
  }, [initializeDashboard]);

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600"></div>
      </div>
    );
  }

  const isBillingPage = pathname === '/dashboard/billing';
  const showPaymentGate = !canAccess && !isBillingPage;

  return (
    <div className="flex min-h-screen">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} transition-all duration-300 overflow-hidden`}>
        <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
      </div>
      <main className="flex-1 p-8 overflow-auto">
        {showPaymentGate ? (
          <PaymentGate 
            isOpen={true} 
            subscriptionStatus={subscriptionStatus}
            trialDaysRemaining={trialDaysRemaining}
          />
        ) : (
          children
        )}
      </main>
    </div>
  );
}

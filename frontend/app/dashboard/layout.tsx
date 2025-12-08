'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import PaymentGate from '@/components/PaymentGate';
import { useAuthStore } from '@/store/auth';
import { useBusinessStore } from '@/store/business';
import { businessApi, authApi, billingApi } from '@/lib/api';

export default function DashboardLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { loadFromStorage, isAuthenticated, setAuth, token, user } = useAuthStore();
  const { setBusinesses, setCurrentBusiness, businesses } = useBusinessStore();
  const [loading, setLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [accessStatus, setAccessStatus] = useState<{
    hasPaymentMethod: boolean;
    canAccess: boolean;
    subscriptionStatus: string;
    trialDaysRemaining: number | null;
  } | null>(null);

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  useEffect(() => {
    if (!isAuthenticated && !loading) {
      router.push('/login');
    }
  }, [isAuthenticated, loading, router]);

  useEffect(() => {
    const fetchData = async () => {
      if (isAuthenticated && token) {
        try {
          const [businessResponse, userResponse, accessResponse] = await Promise.all([
            businessApi.list(),
            authApi.me(),
            billingApi.getAccessStatus()
          ]);
          
          setBusinesses(businessResponse.data);
          if (businessResponse.data.length > 0) {
            setCurrentBusiness(businessResponse.data[0]);
          }
          
          if (userResponse.data) {
            setAuth(userResponse.data, token);
          }

          setAccessStatus(accessResponse.data);
        } catch (error) {
          console.error('Failed to fetch data:', error);
        }
      }
      setLoading(false);
    };

    fetchData();
  }, [isAuthenticated, token, setBusinesses, setCurrentBusiness, setAuth]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  const isBillingPage = pathname === '/dashboard/billing';
  const showPaymentGate = accessStatus && !accessStatus.canAccess && !isBillingPage;

  return (
    <div className="flex min-h-screen">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} transition-all duration-300 overflow-hidden`}>
        <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
      </div>
      <main className="flex-1 p-8 overflow-auto">{children}</main>
      
      <PaymentGate 
        isOpen={!!showPaymentGate} 
        subscriptionStatus={accessStatus?.subscriptionStatus || 'pending'}
        trialDaysRemaining={accessStatus?.trialDaysRemaining}
      />
    </div>
  );
}

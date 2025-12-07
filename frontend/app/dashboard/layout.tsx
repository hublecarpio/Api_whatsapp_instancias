'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import { useAuthStore } from '@/store/auth';
import { useBusinessStore } from '@/store/business';
import { businessApi } from '@/lib/api';

export default function DashboardLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { loadFromStorage, isAuthenticated } = useAuthStore();
  const { setBusinesses, setCurrentBusiness, businesses } = useBusinessStore();
  const [loading, setLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  useEffect(() => {
    if (!isAuthenticated && !loading) {
      router.push('/login');
    }
  }, [isAuthenticated, loading, router]);

  useEffect(() => {
    const fetchBusinesses = async () => {
      if (isAuthenticated) {
        try {
          const response = await businessApi.list();
          setBusinesses(response.data);
          if (response.data.length > 0) {
            setCurrentBusiness(response.data[0]);
          }
        } catch (error) {
          console.error('Failed to fetch businesses:', error);
        }
      }
      setLoading(false);
    };

    fetchBusinesses();
  }, [isAuthenticated, setBusinesses, setCurrentBusiness]);

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

  return (
    <div className="flex min-h-screen">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} transition-all duration-300 overflow-hidden`}>
        <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
      </div>
      <main className="flex-1 p-8 overflow-auto">{children}</main>
    </div>
  );
}

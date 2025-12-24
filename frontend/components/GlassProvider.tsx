'use client';

import { useEffect, createContext, useContext, ReactNode } from 'react';
import { useGlassStore } from '@/store/glass';

interface GlassContextValue {
  glassMode: boolean;
  loading: boolean;
  getCardClass: (baseClass?: string) => string;
  getModalClass: (baseClass?: string) => string;
  getPanelClass: (baseClass?: string) => string;
  getSidebarClass: (baseClass?: string) => string;
}

const GlassContext = createContext<GlassContextValue>({
  glassMode: false,
  loading: true,
  getCardClass: (baseClass) => baseClass || '',
  getModalClass: (baseClass) => baseClass || '',
  getPanelClass: (baseClass) => baseClass || '',
  getSidebarClass: (baseClass) => baseClass || '',
});

export function useGlass() {
  return useContext(GlassContext);
}

export function GlassProvider({ children }: { children: ReactNode }) {
  const { glassMode, loading, fetchGlassMode } = useGlassStore();

  useEffect(() => {
    fetchGlassMode();
  }, [fetchGlassMode]);

  const getCardClass = (baseClass?: string) => {
    if (!glassMode) return baseClass || 'card';
    const base = baseClass || '';
    return `${base} glass-card`.trim();
  };

  const getModalClass = (baseClass?: string) => {
    if (!glassMode) return baseClass || '';
    const base = baseClass || '';
    return `${base} glass-modal`.trim();
  };

  const getPanelClass = (baseClass?: string) => {
    if (!glassMode) return baseClass || '';
    const base = baseClass || '';
    return `${base} glass-panel`.trim();
  };

  const getSidebarClass = (baseClass?: string) => {
    if (!glassMode) return baseClass || '';
    const base = baseClass || '';
    return `${base} glass-sidebar`.trim();
  };

  const value: GlassContextValue = {
    glassMode,
    loading,
    getCardClass,
    getModalClass,
    getPanelClass,
    getSidebarClass,
  };

  return (
    <GlassContext.Provider value={value}>
      {children}
    </GlassContext.Provider>
  );
}

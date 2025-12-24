'use client';

import { useEffect, createContext, useContext, ReactNode } from 'react';
import { useGlassStore } from '@/store/glass';

interface BrandingSettings {
  appName: string;
  appTagline: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
}

interface GlassContextValue {
  glassMode: boolean;
  loading: boolean;
  branding: BrandingSettings;
  getCardClass: (baseClass?: string) => string;
  getModalClass: (baseClass?: string) => string;
  getPanelClass: (baseClass?: string) => string;
  getSidebarClass: (baseClass?: string) => string;
}

const defaultBranding: BrandingSettings = {
  appName: 'Effi',
  appTagline: 'WhatsApp AI Platform',
  logoUrl: null,
  faviconUrl: null,
  primaryColor: '#00D4FF',
  secondaryColor: '#8B5CF6',
  accentColor: '#10B981',
};

const GlassContext = createContext<GlassContextValue>({
  glassMode: false,
  loading: true,
  branding: defaultBranding,
  getCardClass: (baseClass) => baseClass || '',
  getModalClass: (baseClass) => baseClass || '',
  getPanelClass: (baseClass) => baseClass || '',
  getSidebarClass: (baseClass) => baseClass || '',
});

export function useGlass() {
  return useContext(GlassContext);
}

export function useBranding() {
  const { branding } = useContext(GlassContext);
  return branding;
}

function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return '0, 212, 255';
  return `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`;
}

export function GlassProvider({ children }: { children: ReactNode }) {
  const { glassMode, loading, branding, fetchSettings } = useGlassStore();

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    if (glassMode) {
      document.body.classList.add('glass-mode');
    } else {
      document.body.classList.remove('glass-mode');
    }
  }, [glassMode]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--brand-primary', branding.primaryColor);
    root.style.setProperty('--brand-primary-rgb', hexToRgb(branding.primaryColor));
    root.style.setProperty('--brand-secondary', branding.secondaryColor);
    root.style.setProperty('--brand-secondary-rgb', hexToRgb(branding.secondaryColor));
    root.style.setProperty('--brand-accent', branding.accentColor);
    root.style.setProperty('--brand-accent-rgb', hexToRgb(branding.accentColor));
  }, [branding.primaryColor, branding.secondaryColor, branding.accentColor]);

  useEffect(() => {
    if (branding.faviconUrl) {
      let link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = branding.faviconUrl;
    }
  }, [branding.faviconUrl]);

  useEffect(() => {
    if (branding.appName) {
      const baseTitle = document.title.split(' | ').pop() || '';
      if (baseTitle && baseTitle !== branding.appName) {
        document.title = `${branding.appName} | ${baseTitle}`;
      } else if (!baseTitle) {
        document.title = branding.appName;
      }
    }
  }, [branding.appName]);

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
    branding,
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

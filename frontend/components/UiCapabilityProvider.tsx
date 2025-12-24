'use client';

import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';

interface UiCapabilities {
  isMobile: boolean;
  isTouch: boolean;
  supportsGlass: boolean;
  isHydrated: boolean;
}

interface UiContextValue extends UiCapabilities {
  getCardClass: (baseClass?: string) => string;
  getButtonClass: (baseClass?: string) => string;
  getTouchTargetClass: () => string;
  getGridClass: (desktopCols?: number) => string;
}

const defaultCapabilities: UiCapabilities = {
  isMobile: false,
  isTouch: false,
  supportsGlass: true,
  isHydrated: false,
};

const UiContext = createContext<UiContextValue>({
  ...defaultCapabilities,
  getCardClass: (baseClass) => baseClass || '',
  getButtonClass: (baseClass) => baseClass || '',
  getTouchTargetClass: () => '',
  getGridClass: () => 'grid-cols-1',
});

export function useUiContext() {
  return useContext(UiContext);
}

export function UiCapabilityProvider({ children }: { children: ReactNode }) {
  const [capabilities, setCapabilities] = useState<UiCapabilities>(defaultCapabilities);

  const detectCapabilities = useCallback(() => {
    if (typeof window === 'undefined') return;

    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    const supportsGlass = CSS.supports('backdrop-filter', 'blur(1px)') || 
                          CSS.supports('-webkit-backdrop-filter', 'blur(1px)');

    setCapabilities({
      isMobile,
      isTouch,
      supportsGlass,
      isHydrated: true,
    });

    const root = document.documentElement;
    root.setAttribute('data-mobile', isMobile.toString());
    root.setAttribute('data-touch', isTouch.toString());
    root.setAttribute('data-glass-support', supportsGlass.toString());
    
    root.style.setProperty('--ui-columns', isMobile ? '1' : '2');
    root.style.setProperty('--ui-card-width', isMobile ? '100%' : 'auto');
    root.style.setProperty('--ui-glass-blur', isMobile ? '12px' : '20px');
    root.style.setProperty('--ui-touch-target', isTouch ? '44px' : '36px');
  }, []);

  useEffect(() => {
    detectCapabilities();

    const mobileQuery = window.matchMedia('(max-width: 767px)');
    const touchQuery = window.matchMedia('(pointer: coarse)');

    const handleChange = () => detectCapabilities();

    mobileQuery.addEventListener('change', handleChange);
    touchQuery.addEventListener('change', handleChange);
    window.addEventListener('resize', handleChange);

    return () => {
      mobileQuery.removeEventListener('change', handleChange);
      touchQuery.removeEventListener('change', handleChange);
      window.removeEventListener('resize', handleChange);
    };
  }, [detectCapabilities]);

  const getCardClass = useCallback((baseClass?: string) => {
    const base = baseClass || '';
    if (capabilities.isMobile) {
      return `${base} w-full`.trim();
    }
    return base;
  }, [capabilities.isMobile]);

  const getButtonClass = useCallback((baseClass?: string) => {
    const base = baseClass || '';
    if (capabilities.isTouch) {
      return `${base} touch-target`.trim();
    }
    return base;
  }, [capabilities.isTouch]);

  const getTouchTargetClass = useCallback(() => {
    return capabilities.isTouch ? 'touch-target' : '';
  }, [capabilities.isTouch]);

  const getGridClass = useCallback((desktopCols: number = 2) => {
    if (capabilities.isMobile) {
      return 'grid-cols-1';
    }
    return `grid-cols-1 md:grid-cols-${desktopCols}`;
  }, [capabilities.isMobile]);

  const value: UiContextValue = {
    ...capabilities,
    getCardClass,
    getButtonClass,
    getTouchTargetClass,
    getGridClass,
  };

  return (
    <UiContext.Provider value={value}>
      {children}
    </UiContext.Provider>
  );
}

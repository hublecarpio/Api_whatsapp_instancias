import { create } from 'zustand';

interface BrandingSettings {
  appName: string;
  appTagline: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
}

interface GlassState {
  glassMode: boolean;
  brandingEnabled: boolean;
  loading: boolean;
  branding: BrandingSettings;
  setGlassMode: (mode: boolean) => void;
  setBrandingEnabled: (enabled: boolean) => void;
  setBranding: (branding: Partial<BrandingSettings>) => void;
  fetchSettings: () => Promise<void>;
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

export const useGlassStore = create<GlassState>((set) => ({
  glassMode: false,
  brandingEnabled: true,
  loading: true,
  branding: defaultBranding,
  setGlassMode: (mode) => set({ glassMode: mode }),
  setBrandingEnabled: (enabled) => set({ brandingEnabled: enabled }),
  setBranding: (branding) => set((state) => ({ 
    branding: { ...state.branding, ...branding } 
  })),
  fetchSettings: async () => {
    try {
      const response = await fetch('/api/public/ui-settings');
      if (response.ok) {
        const data = await response.json();
        const brandingEnabled = data.brandingEnabled ?? true;
        set({ 
          glassMode: data.glassMode ?? false,
          brandingEnabled,
          branding: brandingEnabled ? {
            appName: data.appName ?? 'Effi',
            appTagline: data.appTagline ?? 'WhatsApp AI Platform',
            logoUrl: data.logoUrl ?? null,
            faviconUrl: data.faviconUrl ?? null,
            primaryColor: data.primaryColor ?? '#00D4FF',
            secondaryColor: data.secondaryColor ?? '#8B5CF6',
            accentColor: data.accentColor ?? '#10B981',
          } : defaultBranding,
          loading: false 
        });
      } else {
        set({ loading: false });
      }
    } catch (error) {
      console.error('Failed to fetch UI settings:', error);
      set({ loading: false });
    }
  }
}));

export const useGlassMode = () => useGlassStore((state) => state.glassMode);
export const useBranding = () => useGlassStore((state) => state.branding);

export function getGlassClasses(glassMode: boolean) {
  if (!glassMode) return '';
  return 'glass-card';
}

export function getGlassModalClasses(glassMode: boolean) {
  if (!glassMode) return '';
  return 'glass-modal';
}

export function getGlassPanelClasses(glassMode: boolean) {
  if (!glassMode) return '';
  return 'glass-panel';
}

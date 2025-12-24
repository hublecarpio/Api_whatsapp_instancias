import { create } from 'zustand';

interface GlassState {
  glassMode: boolean;
  loading: boolean;
  setGlassMode: (mode: boolean) => void;
  fetchGlassMode: () => Promise<void>;
}

export const useGlassStore = create<GlassState>((set) => ({
  glassMode: false,
  loading: true,
  setGlassMode: (mode) => set({ glassMode: mode }),
  fetchGlassMode: async () => {
    try {
      const response = await fetch('/api/public/ui-settings');
      if (response.ok) {
        const data = await response.json();
        set({ glassMode: data.glassMode ?? false, loading: false });
      } else {
        set({ loading: false });
      }
    } catch (error) {
      console.error('Failed to fetch glass mode:', error);
      set({ loading: false });
    }
  }
}));

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

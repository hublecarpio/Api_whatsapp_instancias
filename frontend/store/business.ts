import { create } from 'zustand';

interface Business {
  id: string;
  name: string;
  description?: string;
  industry?: string;
  logoUrl?: string;
  openaiModel?: string;
  openaiApiKey?: string;
  botEnabled: boolean;
  timezone?: string;
  currencyCode?: string;
  currencySymbol?: string;
  instances?: any[];
  policy?: any;
  promptMaster?: any;
  _count?: { products: number; messages: number };
}

interface BusinessState {
  businesses: Business[];
  currentBusiness: Business | null;
  setBusinesses: (businesses: Business[]) => void;
  setCurrentBusiness: (business: Business | null) => void;
  updateBusiness: (id: string, data: Partial<Business>) => void;
  clearBusinesses: () => void;
}

export const useBusinessStore = create<BusinessState>((set) => ({
  businesses: [],
  currentBusiness: null,
  
  setBusinesses: (businesses) => set({ businesses }),
  
  setCurrentBusiness: (business) => set({ currentBusiness: business }),
  
  updateBusiness: (id, data) => set((state) => ({
    businesses: state.businesses.map((b) => 
      b.id === id ? { ...b, ...data } : b
    ),
    currentBusiness: state.currentBusiness?.id === id 
      ? { ...state.currentBusiness, ...data } 
      : state.currentBusiness
  })),

  clearBusinesses: () => set({ businesses: [], currentBusiness: null })
}));

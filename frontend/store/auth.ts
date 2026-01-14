import { create } from 'zustand';

interface User {
  id: string;
  name: string;
  email: string;
  phone?: string;
  googlePicture?: string;
  emailVerified?: boolean;
  subscriptionStatus?: 'pending' | 'trial' | 'active' | 'past_due' | 'canceled';
  needsSubscription?: boolean;
  isPro?: boolean;
  paymentLinkEnabled?: boolean;
  proBonusExpiresAt?: string;
  hasActiveBonus?: boolean;
  hasStripeSubscription?: boolean;
  planType?: 'pro' | 'basic' | 'trial' | 'none';
  role?: 'ADMIN' | 'ASESOR';
  parentUserId?: string | null;
}

export interface UserContext {
  businessId: string;
  businessName: string;
  role: 'OWNER' | 'ADVISOR';
  logoUrl?: string | null;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  contexts: UserContext[];
  activeContext: UserContext | null;
  setAuth: (user: User, token: string, contexts?: UserContext[]) => void;
  updateUser: (user: Partial<User>) => void;
  setContexts: (contexts: UserContext[]) => void;
  setActiveContext: (context: UserContext | null) => void;
  logout: () => void;
  clearUserData: () => void;
  loadFromStorage: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  isAuthenticated: false,
  contexts: [],
  activeContext: null,
  
  setAuth: (user, token, contexts = []) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('contexts', JSON.stringify(contexts));
      if (contexts.length > 0) {
        const savedActiveContextId = localStorage.getItem('activeContextId');
        const activeCtx = contexts.find(c => c.businessId === savedActiveContextId) || contexts[0];
        localStorage.setItem('activeContextId', activeCtx.businessId);
        set({ user, token, isAuthenticated: true, contexts, activeContext: activeCtx });
      } else {
        set({ user, token, isAuthenticated: true, contexts, activeContext: null });
      }
    } else {
      set({ user, token, isAuthenticated: true, contexts, activeContext: contexts[0] || null });
    }
  },
  
  updateUser: (userData) => {
    const currentUser = get().user;
    if (currentUser) {
      const updatedUser = { ...currentUser, ...userData };
      if (typeof window !== 'undefined') {
        localStorage.setItem('user', JSON.stringify(updatedUser));
      }
      set({ user: updatedUser });
    }
  },
  
  setContexts: (contexts) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('contexts', JSON.stringify(contexts));
    }
    const currentActive = get().activeContext;
    if (!currentActive && contexts.length > 0) {
      const savedId = typeof window !== 'undefined' ? localStorage.getItem('activeContextId') : null;
      const activeCtx = contexts.find(c => c.businessId === savedId) || contexts[0];
      set({ contexts, activeContext: activeCtx });
    } else {
      set({ contexts });
    }
  },
  
  setActiveContext: (context) => {
    if (typeof window !== 'undefined' && context) {
      localStorage.setItem('activeContextId', context.businessId);
    }
    set({ activeContext: context });
  },
  
  logout: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('contexts');
      localStorage.removeItem('activeContextId');
    }
    set({ user: null, token: null, isAuthenticated: false, contexts: [], activeContext: null });
  },
  
  clearUserData: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('user');
    }
    set({ user: null, isAuthenticated: false });
  },
  
  loadFromStorage: () => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('token');
      const userStr = localStorage.getItem('user');
      const contextsStr = localStorage.getItem('contexts');
      const activeContextId = localStorage.getItem('activeContextId');
      
      if (token && userStr) {
        try {
          const user = JSON.parse(userStr);
          let contexts: UserContext[] = [];
          let activeContext: UserContext | null = null;
          
          if (contextsStr) {
            contexts = JSON.parse(contextsStr);
            activeContext = contexts.find(c => c.businessId === activeContextId) || contexts[0] || null;
          }
          
          set({ user, token, isAuthenticated: true, contexts, activeContext });
        } catch (e) {
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          localStorage.removeItem('contexts');
        }
      }
    }
  }
}));

import { create } from 'zustand';

interface User {
  id: string;
  name: string;
  email: string;
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

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  setAuth: (user: User, token: string) => void;
  updateUser: (user: Partial<User>) => void;
  logout: () => void;
  clearUserData: () => void;
  loadFromStorage: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  isAuthenticated: false,
  
  setAuth: (user, token) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
    }
    set({ user, token, isAuthenticated: true });
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
  
  logout: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    }
    set({ user: null, token: null, isAuthenticated: false });
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
      if (token && userStr) {
        try {
          const user = JSON.parse(userStr);
          set({ user, token, isAuthenticated: true });
        } catch (e) {
          localStorage.removeItem('token');
          localStorage.removeItem('user');
        }
      }
    }
  }
}));

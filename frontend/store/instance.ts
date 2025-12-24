import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface WhatsAppInstance {
  id: string;
  businessId: string;
  name: string;
  provider: 'BAILEYS' | 'META_CLOUD';
  instanceBackendId?: string;
  phoneNumber?: string;
  status: string;
  qr?: string;
  isActive: boolean;
  botEnabled?: boolean;
  webhookConfig?: any;
  lastConnection?: string;
  createdAt: string;
  businessObjective?: 'SALES' | 'APPOINTMENTS';
  metaCredential?: { id: string; phoneNumberId: string };
}

export interface InstanceLimits {
  current: number;
  max: number;
  tier: string;
  canAddMore: boolean;
}

interface InstanceState {
  instances: WhatsAppInstance[];
  selectedInstanceId: string | null;
  limits: InstanceLimits | null;
  
  setInstances: (instances: WhatsAppInstance[]) => void;
  setSelectedInstanceId: (id: string | null) => void;
  setLimits: (limits: InstanceLimits) => void;
  getSelectedInstance: () => WhatsAppInstance | null;
  addInstance: (instance: WhatsAppInstance) => void;
  updateInstance: (id: string, data: Partial<WhatsAppInstance>) => void;
  removeInstance: (id: string) => void;
  clearInstances: () => void;
}

export const useInstanceStore = create<InstanceState>()(
  persist(
    (set, get) => ({
      instances: [],
      selectedInstanceId: null,
      limits: null,
      
      setInstances: (instances) => {
        const state = get();
        const safeInstances = Array.isArray(instances) ? instances : [];
        const newSelectedId = safeInstances.length > 0 
          ? (safeInstances.find(i => i.id === state.selectedInstanceId)?.id || safeInstances[0].id)
          : null;
        set({ instances: safeInstances, selectedInstanceId: newSelectedId });
      },
      
      setSelectedInstanceId: (id) => set({ selectedInstanceId: id }),
      
      setLimits: (limits) => set({ limits }),
      
      getSelectedInstance: () => {
        const state = get();
        const safeInstances = Array.isArray(state.instances) ? state.instances : [];
        return safeInstances.find(i => i.id === state.selectedInstanceId) || safeInstances[0] || null;
      },
      
      addInstance: (instance) => set((state) => {
        const safeInstances = Array.isArray(state.instances) ? state.instances : [];
        return {
          instances: [...safeInstances, instance],
          selectedInstanceId: instance.id
        };
      }),
      
      updateInstance: (id, data) => set((state) => {
        const safeInstances = Array.isArray(state.instances) ? state.instances : [];
        return {
          instances: safeInstances.map((i) => 
            i.id === id ? { ...i, ...data } : i
          )
        };
      }),
      
      removeInstance: (id) => set((state) => {
        const safeInstances = Array.isArray(state.instances) ? state.instances : [];
        const filtered = safeInstances.filter(i => i.id !== id);
        const newSelectedId = state.selectedInstanceId === id 
          ? (filtered[0]?.id || null)
          : state.selectedInstanceId;
        return { instances: filtered, selectedInstanceId: newSelectedId };
      }),
      
      clearInstances: () => set({ instances: [], selectedInstanceId: null, limits: null })
    }),
    {
      name: 'whatsapp-instance-storage',
      partialize: (state) => ({ selectedInstanceId: state.selectedInstanceId })
    }
  )
);

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useBusinessStore } from '@/store/business';
import { waApi } from '@/lib/api';
import { MessageSquare, Phone, Wifi, WifiOff, ChevronRight } from 'lucide-react';

interface WhatsAppInstance {
  id: string;
  instanceNumber: number;
  name: string;
  provider: string;
  phoneNumber: string | null;
  status: string;
}

export default function ChatsPage() {
  const router = useRouter();
  const { currentBusiness } = useBusinessStore();
  const [instances, setInstances] = useState<WhatsAppInstance[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (currentBusiness?.id) {
      loadInstances();
    }
  }, [currentBusiness?.id]);

  const loadInstances = async () => {
    if (!currentBusiness?.id) return;
    
    try {
      setLoading(true);
      const response = await waApi.getInstances(currentBusiness.id);
      setInstances(response.data || []);
    } catch (error) {
      console.error('Failed to load instances:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'connected':
      case 'open':
        return 'text-green-400';
      case 'pending_qr':
      case 'connecting':
        return 'text-yellow-400';
      default:
        return 'text-gray-400';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'connected':
      case 'open':
        return <Wifi className="w-4 h-4" />;
      default:
        return <WifiOff className="w-4 h-4" />;
    }
  };

  const getProviderLabel = (provider: string) => {
    switch (provider) {
      case 'BAILEYS':
        return 'WhatsApp Web';
      case 'META_CLOUD':
        return 'Meta Cloud API';
      case 'META_COEXIST':
        return 'Meta Coexistencia';
      default:
        return provider;
    }
  };

  const handleSelectInstance = (instance: WhatsAppInstance) => {
    router.push(`/dashboard/chats/${instance.instanceNumber}`);
  };

  if (!currentBusiness) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-400">Selecciona un negocio para ver los chats</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-6 border-b border-gray-700">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <MessageSquare className="w-6 h-6 text-cyan-400" />
          Chats por Instancia
        </h1>
        <p className="text-gray-400 mt-1">
          Selecciona un numero de WhatsApp para ver sus conversaciones
        </p>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-400"></div>
          </div>
        ) : instances.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-400">
            <Phone className="w-12 h-12 mb-4 opacity-50" />
            <p>No tienes instancias de WhatsApp configuradas</p>
            <button 
              onClick={() => router.push('/dashboard/whatsapp')}
              className="mt-4 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-500 transition"
            >
              Configurar WhatsApp
            </button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {instances.map((instance) => (
              <div
                key={instance.id}
                onClick={() => handleSelectInstance(instance)}
                className="bg-gray-800 rounded-xl p-6 cursor-pointer hover:bg-gray-700 transition border border-gray-700 hover:border-cyan-500 group"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-cyan-600/20 flex items-center justify-center">
                      <span className="text-xl font-bold text-cyan-400">
                        {instance.instanceNumber}
                      </span>
                    </div>
                    <div>
                      <h3 className="font-semibold text-white">{instance.name}</h3>
                      <p className="text-sm text-gray-400">{getProviderLabel(instance.provider)}</p>
                    </div>
                  </div>
                  <ChevronRight className="w-5 h-5 text-gray-500 group-hover:text-cyan-400 transition" />
                </div>
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="w-4 h-4 text-gray-500" />
                    <span className="text-gray-300">
                      {instance.phoneNumber || 'Sin numero'}
                    </span>
                  </div>
                  <div className={`flex items-center gap-1 ${getStatusColor(instance.status)}`}>
                    {getStatusIcon(instance.status)}
                    <span className="text-xs capitalize">{instance.status}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useInstanceStore, WhatsAppInstance, InstanceLimits } from '@/store/instance';
import { useAuthStore } from '@/store/auth';
import { waApi } from '@/lib/api';

interface InstanceSelectorProps {
  businessId: string;
  onInstanceSelect?: (instance: WhatsAppInstance) => void;
  showAddButton?: boolean;
  compact?: boolean;
}

export default function InstanceSelector({ 
  businessId, 
  onInstanceSelect,
  showAddButton = true,
  compact = false
}: InstanceSelectorProps) {
  const { user } = useAuthStore();
  const { 
    instances, 
    selectedInstanceId, 
    limits,
    setInstances, 
    setSelectedInstanceId,
    setLimits,
    getSelectedInstance
  } = useInstanceStore();
  
  const [loading, setLoading] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState('');
  const [newInstanceName, setNewInstanceName] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<'BAILEYS' | 'META_CLOUD'>('BAILEYS');
  const [copyFromInstance, setCopyFromInstance] = useState<string>('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [countryCode, setCountryCode] = useState('+51');
  
  const COUNTRY_CODES = [
    { code: '+51', country: 'Peru', flag: '🇵🇪' },
    { code: '+52', country: 'Mexico', flag: '🇲🇽' },
    { code: '+1', country: 'USA/Canada', flag: '🇺🇸' },
    { code: '+34', country: 'España', flag: '🇪🇸' },
    { code: '+57', country: 'Colombia', flag: '🇨🇴' },
    { code: '+54', country: 'Argentina', flag: '🇦🇷' },
    { code: '+55', country: 'Brasil', flag: '🇧🇷' },
    { code: '+56', country: 'Chile', flag: '🇨🇱' },
  ];

  const fetchInstances = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      const response = await waApi.listInstances(businessId);
      setInstances(response.data.instances || []);
      setLimits(response.data.limits);
    } catch (error) {
      console.error('Error fetching instances:', error);
    } finally {
      setLoading(false);
    }
  }, [businessId, setInstances, setLimits]);

  useEffect(() => {
    fetchInstances();
  }, [fetchInstances]);

  const handleSelectInstance = (instance: WhatsAppInstance) => {
    setSelectedInstanceId(instance.id);
    onInstanceSelect?.(instance);
  };

  const handleAddInstance = async () => {
    if (!businessId) return;
    
    if (selectedProvider === 'BAILEYS' && !phoneNumber) {
      setAddError('El numero de telefono es obligatorio');
      return;
    }
    
    setAddLoading(true);
    setAddError('');
    
    const fullPhone = selectedProvider === 'BAILEYS' 
      ? `${countryCode.replace('+', '')}${phoneNumber.replace(/\D/g, '')}`
      : undefined;
    
    try {
      const response = await waApi.addInstance({
        businessId,
        name: newInstanceName || undefined,
        provider: selectedProvider,
        phoneNumber: fullPhone,
        copyFromInstanceId: copyFromInstance || undefined
      });
      
      await fetchInstances();
      setShowAddModal(false);
      setNewInstanceName('');
      setCopyFromInstance('');
      setPhoneNumber('');
      
      if (response.data.instance) {
        setSelectedInstanceId(response.data.instance.id);
        onInstanceSelect?.(response.data.instance);
      }
    } catch (error: any) {
      setAddError(error.response?.data?.error || 'Error al agregar instancia');
    } finally {
      setAddLoading(false);
    }
  };

  const canAddMore = limits?.canAddMore ?? false;
  const isPro = user?.isPro || ['PRO', 'ENTERPRISE'].includes(limits?.tier || '');
  const selectedInstance = getSelectedInstance();

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <select
          value={selectedInstanceId || ''}
          onChange={(e) => {
            const inst = instances.find(i => i.id === e.target.value);
            if (inst) handleSelectInstance(inst);
          }}
          className="bg-dark-surface border border-dark-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-neon-blue/50 focus:border-neon-blue"
        >
          {instances.map((inst) => (
            <option key={inst.id} value={inst.id}>
              {inst.name} {inst.phoneNumber ? `(${inst.phoneNumber})` : ''} - {inst.status === 'open' ? '🟢' : '🔴'}
            </option>
          ))}
        </select>
        {showAddButton && canAddMore && (
          <button
            onClick={() => setShowAddModal(true)}
            className="p-2 text-neon-blue hover:bg-neon-blue/10 rounded-lg transition-colors"
            title="Agregar numero"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-white">Numeros de WhatsApp</h3>
        {limits && (
          <span className="text-sm text-gray-400">
            {limits.current} / {limits.max} numeros ({limits.tier})
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-neon-blue border-t-transparent"></div>
        </div>
      ) : instances.length === 0 ? (
        <div className="text-center py-8 text-gray-400">
          <p>No tienes numeros de WhatsApp configurados</p>
          {showAddButton && (
            <button
              onClick={() => setShowAddModal(true)}
              className="mt-4 btn-primary"
            >
              Agregar primer numero
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          {instances.map((instance) => (
            <div
              key={instance.id}
              onClick={() => handleSelectInstance(instance)}
              className={`p-4 rounded-xl border cursor-pointer transition-all ${
                selectedInstanceId === instance.id
                  ? 'border-neon-blue bg-neon-blue/10'
                  : 'border-dark-border bg-dark-surface hover:border-gray-600'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${
                    instance.status === 'open' || instance.status === 'connected' 
                      ? 'bg-green-500' 
                      : instance.status === 'pending_qr'
                      ? 'bg-yellow-500'
                      : 'bg-red-500'
                  }`} />
                  <div>
                    <h4 className="font-medium text-white">{instance.name}</h4>
                    <p className="text-sm text-gray-400">
                      {instance.phoneNumber || 'Sin numero'} 
                      <span className="ml-2 text-xs">
                        ({instance.provider === 'META_CLOUD' ? 'Meta Cloud' : 'Baileys'})
                      </span>
                    </p>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="text-xs text-gray-500">
                    {instance.status === 'open' || instance.status === 'connected' 
                      ? 'Conectado' 
                      : instance.status === 'pending_qr'
                      ? 'Esperando QR'
                      : instance.status === 'pending_credentials'
                      ? 'Config. pendiente'
                      : 'Desconectado'}
                  </span>
                  {isPro && (instance.status === 'open' || instance.status === 'connected') && (
                    <span className="text-xs text-neon-blue flex items-center gap-1">
                      🔑 Ver API
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAddButton && canAddMore && instances.length > 0 && (
        <button
          onClick={() => setShowAddModal(true)}
          className="w-full p-4 border-2 border-dashed border-dark-border rounded-xl text-gray-400 hover:border-neon-blue hover:text-neon-blue transition-colors flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Agregar otro numero
        </button>
      )}

      {showAddButton && !canAddMore && isPro && instances.length > 0 && (
        <p className="text-center text-sm text-gray-500">
          Has alcanzado el limite de numeros para tu plan
        </p>
      )}

      {showAddButton && !isPro && instances.length > 0 && (
        <div className="p-4 bg-gradient-to-r from-neon-blue/10 to-purple-500/10 rounded-xl border border-neon-blue/20">
          <p className="text-sm text-gray-300">
            <span className="font-semibold text-neon-blue">PRO</span> y{' '}
            <span className="font-semibold text-purple-400">Enterprise</span>{' '}
            pueden agregar multiples numeros de WhatsApp
          </p>
        </div>
      )}

      {showAddModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[100] p-4 overflow-y-auto">
          <div className="bg-dark-card rounded-2xl p-6 max-w-md w-full space-y-5 border border-dark-border shadow-2xl my-auto max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-bold text-white text-center">Agregar nuevo numero</h3>
            
            {addError && (
              <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-sm text-center">
                {addError}
              </div>
            )}
            
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                Nombre (opcional)
              </label>
              <input
                type="text"
                value={newInstanceName}
                onChange={(e) => setNewInstanceName(e.target.value)}
                placeholder="Ej: WhatsApp Ventas"
                className="w-full bg-dark-surface border border-dark-border rounded-lg px-4 py-3 focus:ring-2 focus:ring-neon-blue/50"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                Tipo de conexion
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setSelectedProvider('BAILEYS')}
                  className={`p-4 rounded-xl border-2 transition-all text-center ${
                    selectedProvider === 'BAILEYS'
                      ? 'border-neon-blue bg-neon-blue/10'
                      : 'border-dark-border hover:border-gray-600'
                  }`}
                >
                  <div className="text-2xl mb-1">📱</div>
                  <div className="font-medium text-white">WhatsApp QR</div>
                  <div className="text-xs text-gray-400">Escanea con tu celular</div>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedProvider('META_CLOUD')}
                  className={`p-4 rounded-xl border-2 transition-all text-center ${
                    selectedProvider === 'META_CLOUD'
                      ? 'border-neon-blue bg-neon-blue/10'
                      : 'border-dark-border hover:border-gray-600'
                  }`}
                >
                  <div className="text-2xl mb-1">☁️</div>
                  <div className="font-medium text-white">Meta Cloud</div>
                  <div className="text-xs text-gray-400">API oficial de Meta</div>
                </button>
              </div>
            </div>
            
            {selectedProvider === 'BAILEYS' && (
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">
                  Numero de telefono <span className="text-red-400">*</span>
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <select
                    value={countryCode}
                    onChange={(e) => setCountryCode(e.target.value)}
                    className="bg-dark-surface border border-dark-border rounded-lg px-3 py-3 focus:ring-2 focus:ring-neon-blue/50 w-full sm:w-auto"
                  >
                    {COUNTRY_CODES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.flag} {c.code}
                      </option>
                    ))}
                  </select>
                  <input
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, ''))}
                    placeholder="Numero sin codigo de pais"
                    className="flex-1 bg-dark-surface border border-dark-border rounded-lg px-4 py-3 focus:ring-2 focus:ring-neon-blue/50 w-full"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Ingresa el numero que vas a escanear con el QR
                </p>
              </div>
            )}
            
            {instances.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">
                  Copiar configuracion de (opcional)
                </label>
                <select
                  value={copyFromInstance}
                  onChange={(e) => setCopyFromInstance(e.target.value)}
                  className="w-full bg-dark-surface border border-dark-border rounded-lg px-4 py-2 focus:ring-2 focus:ring-neon-blue/50"
                >
                  <option value="">No copiar, empezar vacio</option>
                  {instances.map((inst) => (
                    <option key={inst.id} value={inst.id}>
                      {inst.name} {inst.phoneNumber ? `(${inst.phoneNumber})` : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Copia prompts, herramientas y configuracion de seguimientos
                </p>
              </div>
            )}
            
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  setShowAddModal(false);
                  setAddError('');
                  setNewInstanceName('');
                  setCopyFromInstance('');
                }}
                className="flex-1 px-4 py-2 bg-dark-surface border border-dark-border rounded-lg hover:bg-dark-hover transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleAddInstance}
                disabled={addLoading}
                className="flex-1 btn-primary disabled:opacity-50"
              >
                {addLoading ? 'Agregando...' : 'Agregar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

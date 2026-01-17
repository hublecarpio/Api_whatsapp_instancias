'use client';

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useInstanceStore, WhatsAppInstance, InstanceLimits } from '@/store/instance';
import { useAuthStore } from '@/store/auth';
import { useGlassStore } from '@/store/glass';
import { waApi } from '@/lib/api';
import MetaEmbeddedSignup from './MetaEmbeddedSignup';

interface InstanceSelectorProps {
  businessId: string;
  onInstanceSelect?: (instance: WhatsAppInstance) => void;
  onInstanceDeleted?: () => void;
  showAddButton?: boolean;
  compact?: boolean;
}

export default function InstanceSelector({ 
  businessId, 
  onInstanceSelect,
  onInstanceDeleted,
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
    getSelectedInstance,
    removeInstance
  } = useInstanceStore();
  
  const [loading, setLoading] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState('');
  const [newInstanceName, setNewInstanceName] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<'BAILEYS' | 'META_CLOUD' | 'META_COEXIST'>('BAILEYS');
  const [startingCoexist, setStartingCoexist] = useState(false);
  const [copyFromInstance, setCopyFromInstance] = useState<string>('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [countryCode, setCountryCode] = useState('+51');
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [metaAccessToken, setMetaAccessToken] = useState('');
  const [metaPhoneNumberId, setMetaPhoneNumberId] = useState('');
  const [metaWabaId, setMetaWabaId] = useState('');
  const [metaAppId, setMetaAppId] = useState('');
  const [metaAppSecret, setMetaAppSecret] = useState('');
  const [metaPhoneNumber, setMetaPhoneNumber] = useState('');
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [showArchivedModal, setShowArchivedModal] = useState(false);
  const [archivedInstances, setArchivedInstances] = useState<any[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [permanentDeleteId, setPermanentDeleteId] = useState<string | null>(null);
  const [permanentDeleteLoading, setPermanentDeleteLoading] = useState(false);
  
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

  const handleReconnect = async (instance: WhatsAppInstance, e: React.MouseEvent) => {
    e.stopPropagation();
    
    if (instance.provider === 'META_CLOUD' || instance.provider === 'META_COEXIST') {
      handleSelectInstance(instance);
      return;
    }
    
    setReconnectingId(instance.id);
    try {
      await waApi.instanceRestart(instance.id, businessId);
      await fetchInstances();
      handleSelectInstance(instance);
    } catch (error) {
      console.error('Error reconnecting:', error);
      handleSelectInstance(instance);
    } finally {
      setReconnectingId(null);
    }
  };

  const handleAddInstance = async () => {
    if (!businessId) return;
    
    if (selectedProvider === 'BAILEYS' && !phoneNumber) {
      setAddError('El numero de telefono es obligatorio');
      return;
    }
    
    if (selectedProvider === 'META_CLOUD') {
      if (!metaAppId || !metaAppSecret || !metaWabaId || !metaPhoneNumberId || !metaPhoneNumber || !metaAccessToken) {
        setAddError('Todos los campos son obligatorios para Meta Cloud');
        return;
      }
    }
    
    setAddLoading(true);
    setAddError('');
    
    const fullPhone = selectedProvider === 'BAILEYS' 
      ? `${countryCode.replace('+', '')}${phoneNumber.replace(/\D/g, '')}`
      : selectedProvider === 'META_CLOUD' 
        ? metaPhoneNumber 
        : undefined;
    
    try {
      const response = await waApi.addInstance({
        businessId,
        name: newInstanceName || undefined,
        provider: selectedProvider as 'BAILEYS' | 'META_CLOUD',
        phoneNumber: fullPhone,
        copyFromInstanceId: copyFromInstance || undefined,
        metaCredentials: selectedProvider === 'META_CLOUD' ? {
          appId: metaAppId,
          appSecret: metaAppSecret,
          accessToken: metaAccessToken,
          phoneNumberId: metaPhoneNumberId,
          wabaId: metaWabaId
        } : undefined
      });
      
      await fetchInstances();
      setShowAddModal(false);
      setNewInstanceName('');
      setCopyFromInstance('');
      setPhoneNumber('');
      setMetaAccessToken('');
      setMetaPhoneNumberId('');
      setMetaWabaId('');
      
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

  const handleDeleteInstance = async (instanceId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteLoading(instanceId);
    
    try {
      await waApi.deleteInstance(instanceId, businessId);
      removeInstance(instanceId);
      
      if (selectedInstanceId === instanceId) {
        setSelectedInstanceId(null);
      }
      
      await fetchInstances();
      setShowDeleteConfirm(null);
      onInstanceDeleted?.();
    } catch (error: any) {
      console.error('Error deleting instance:', error);
      setAddError(error.response?.data?.error || 'Error al eliminar instancia');
    } finally {
      setDeleteLoading(null);
    }
  };

  const fetchArchivedInstances = async () => {
    if (!businessId) return;
    setArchivedLoading(true);
    try {
      const response = await waApi.listArchivedInstances(businessId);
      setArchivedInstances(response.data || []);
    } catch (error) {
      console.error('Error fetching archived instances:', error);
    } finally {
      setArchivedLoading(false);
    }
  };

  const handleRestoreInstance = async (instanceId: string) => {
    setRestoringId(instanceId);
    try {
      await waApi.restoreInstance(instanceId, businessId);
      await fetchArchivedInstances();
      await fetchInstances();
    } catch (error: any) {
      console.error('Error restoring instance:', error);
      setAddError(error.response?.data?.error || 'Error al restaurar instancia');
    } finally {
      setRestoringId(null);
    }
  };

  const handlePermanentDelete = async (instanceId: string, deleteMessages: boolean) => {
    setPermanentDeleteLoading(true);
    try {
      await waApi.permanentDeleteInstance(instanceId, businessId, deleteMessages);
      await fetchArchivedInstances();
      setPermanentDeleteId(null);
    } catch (error: any) {
      console.error('Error permanently deleting instance:', error);
      setAddError(error.response?.data?.error || 'Error al eliminar permanentemente');
    } finally {
      setPermanentDeleteLoading(false);
    }
  };

  const handleOpenArchived = () => {
    setShowArchivedModal(true);
    fetchArchivedInstances();
  };

  const handleStartCoexistence = async () => {
    if (!businessId) return;
    
    setStartingCoexist(true);
    setAddError('');
    
    try {
      const response = await waApi.startMetaCoexist(businessId);
      const authUrl = response.data.redirectUrl || response.data.authUrl;
      if (authUrl) {
        window.location.href = authUrl;
      } else {
        throw new Error('No se recibio URL de autorizacion');
      }
    } catch (error: any) {
      setAddError(error.response?.data?.error || 'Error al iniciar Meta Coexistence');
    } finally {
      setStartingCoexist(false);
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
            onClick={() => {
              setSelectedProvider('BAILEYS');
              setNewInstanceName('');
              setCopyFromInstance('');
              setPhoneNumber('');
              setAddError('');
              setMetaAccessToken('');
              setMetaPhoneNumberId('');
              setMetaWabaId('');
              setShowAddModal(true);
            }}
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
        <div className="flex items-center gap-3">
          <button
            onClick={handleOpenArchived}
            className="text-sm text-gray-400 hover:text-neon-blue transition-colors flex items-center gap-1"
            title="Ver instancias archivadas"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
            </svg>
            Archivadas
          </button>
          {limits && (
            <span className="text-sm text-gray-400">
              {limits.current} / {limits.max} numeros ({limits.tier})
            </span>
          )}
        </div>
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
              onClick={() => {
                setSelectedProvider('BAILEYS');
                setNewInstanceName('');
                setCopyFromInstance('');
                setPhoneNumber('');
                setAddError('');
                setMetaAccessToken('');
                setMetaPhoneNumberId('');
                setMetaWabaId('');
                setShowAddModal(true);
              }}
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
              className={`p-4 rounded-xl border cursor-pointer transition-all group ${
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
                      : instance.status === 'pending_qr' || instance.status === 'requires_qr'
                      ? 'bg-yellow-500'
                      : 'bg-red-500'
                  }`} />
                  <div>
                    <h4 className="font-medium text-white">{instance.name}</h4>
                    <p className="text-sm text-gray-400">
                      {instance.phoneNumber || 'Sin numero'} 
                      <span className="ml-2 text-xs">
                        ({instance.provider === 'META_CLOUD' ? 'Meta Cloud' : instance.provider === 'META_COEXIST' ? 'Meta Coexist' : 'Baileys'})
                      </span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-xs text-gray-500">
                      {instance.status === 'open' || instance.status === 'connected' 
                        ? 'Conectado' 
                        : instance.status === 'pending_qr' || instance.status === 'requires_qr'
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
                  {instance.status !== 'open' && instance.status !== 'connected' && instance.status !== 'pending_qr' && instance.status !== 'requires_qr' && instance.status !== 'pending_credentials' && (
                    <button
                      onClick={(e) => handleReconnect(instance, e)}
                      disabled={reconnectingId === instance.id}
                      className="px-3 py-1.5 text-xs bg-neon-blue/20 text-neon-blue hover:bg-neon-blue/30 rounded-lg transition-all flex items-center gap-1 disabled:opacity-50"
                      title="Reconectar"
                    >
                      {reconnectingId === instance.id ? (
                        <div className="w-3.5 h-3.5 border-2 border-neon-blue/30 border-t-neon-blue rounded-full animate-spin" />
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      )}
                      {reconnectingId === instance.id ? 'Reconectando...' : 'Reconectar'}
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDeleteConfirm(instance.id);
                    }}
                    className="p-2 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                    title="Eliminar instancia"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAddButton && canAddMore && instances.length > 0 && (
        <button
          onClick={() => {
            setSelectedProvider('BAILEYS');
            setNewInstanceName('');
            setCopyFromInstance('');
            setPhoneNumber('');
            setAddError('');
            setMetaAccessToken('');
            setMetaPhoneNumberId('');
            setMetaWabaId('');
            setShowAddModal(true);
          }}
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

      {showAddButton && !canAddMore && !isPro && instances.length > 0 && (
        <div className="p-4 bg-gradient-to-r from-neon-blue/10 to-purple-500/10 rounded-xl border border-neon-blue/20">
          <p className="text-sm text-gray-300">
            Has alcanzado el limite de numeros para tu plan.{' '}
            <span className="font-semibold text-neon-blue">PRO</span>{' '}
            permite hasta 10 numeros de WhatsApp.
          </p>
        </div>
      )}

      {showAddModal && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[9999] p-4">
          <div className="bg-dark-card rounded-2xl p-6 max-w-md w-full space-y-5 border border-dark-border shadow-2xl max-h-[90vh] overflow-y-auto">
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
            
            <ProviderSelector 
              selectedProvider={selectedProvider} 
              setSelectedProvider={setSelectedProvider} 
            />
            
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
            
            {instances.length > 0 && selectedProvider === 'BAILEYS' && (
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
            
            {selectedProvider === 'META_CLOUD' && (
              <div className="space-y-4 p-4 bg-dark-surface rounded-xl border border-neon-blue/30 max-h-[60vh] overflow-y-auto">
                <div className="flex items-center gap-2 text-neon-blue mb-2">
                  <span className="text-xl">☁️</span>
                  <span className="font-medium">Configuracion Meta Cloud API</span>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">
                      App ID <span className="text-red-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={metaAppId}
                      onChange={(e) => setMetaAppId(e.target.value)}
                      placeholder="ID de tu App de Meta"
                      className="w-full bg-dark-bg border border-dark-border rounded-lg px-4 py-3 focus:ring-2 focus:ring-neon-blue/50 text-sm"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">
                      App Secret <span className="text-red-400">*</span>
                    </label>
                    <input
                      type="password"
                      value={metaAppSecret}
                      onChange={(e) => setMetaAppSecret(e.target.value)}
                      placeholder="Secret de tu App de Meta"
                      className="w-full bg-dark-bg border border-dark-border rounded-lg px-4 py-3 focus:ring-2 focus:ring-neon-blue/50 text-sm"
                    />
                  </div>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">
                    WABA ID <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={metaWabaId}
                    onChange={(e) => setMetaWabaId(e.target.value)}
                    placeholder="ID de tu cuenta de WhatsApp Business"
                    className="w-full bg-dark-bg border border-dark-border rounded-lg px-4 py-3 focus:ring-2 focus:ring-neon-blue/50 text-sm"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">
                    Phone Number ID <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={metaPhoneNumberId}
                    onChange={(e) => setMetaPhoneNumberId(e.target.value)}
                    placeholder="ID del numero de telefono en Meta"
                    className="w-full bg-dark-bg border border-dark-border rounded-lg px-4 py-3 focus:ring-2 focus:ring-neon-blue/50 text-sm"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">
                    Numero de WhatsApp <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="tel"
                    value={metaPhoneNumber}
                    onChange={(e) => setMetaPhoneNumber(e.target.value.replace(/\D/g, ''))}
                    placeholder="Ej: 51999888777 (con codigo de pais)"
                    className="w-full bg-dark-bg border border-dark-border rounded-lg px-4 py-3 focus:ring-2 focus:ring-neon-blue/50 text-sm"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">
                    Access Token <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="password"
                    value={metaAccessToken}
                    onChange={(e) => setMetaAccessToken(e.target.value)}
                    placeholder="Token de acceso permanente"
                    className="w-full bg-dark-bg border border-dark-border rounded-lg px-4 py-3 focus:ring-2 focus:ring-neon-blue/50 text-sm"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Obtiene el token desde Meta Business Suite o tu System User
                  </p>
                </div>
                
                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddModal(false);
                      setAddError('');
                      setMetaAccessToken('');
                      setMetaPhoneNumberId('');
                      setMetaWabaId('');
                      setMetaAppId('');
                      setMetaAppSecret('');
                      setMetaPhoneNumber('');
                    }}
                    className="flex-1 px-4 py-2 bg-dark-surface border border-dark-border rounded-lg hover:bg-dark-hover transition-colors"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={handleAddInstance}
                    disabled={addLoading || !metaAppId || !metaAppSecret || !metaWabaId || !metaPhoneNumberId || !metaPhoneNumber || !metaAccessToken}
                    className="flex-1 disabled:opacity-50 btn-primary"
                  >
                    {addLoading ? 'Conectando...' : 'Conectar'}
                  </button>
                </div>
              </div>
            )}
            
            {selectedProvider === 'META_COEXIST' && (
              <MetaEmbeddedSignup
                businessId={businessId}
                provider="META_COEXIST"
                onSuccess={(instance) => {
                  fetchInstances();
                  setShowAddModal(false);
                  setSelectedInstanceId(instance.id);
                  onInstanceSelect?.(instance);
                }}
                onError={(error) => setAddError(error)}
                onCancel={() => {
                  setShowAddModal(false);
                  setAddError('');
                }}
              />
            )}
            
            {selectedProvider === 'BAILEYS' && (
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
                  className="flex-1 disabled:opacity-50 btn-primary"
                >
                  {addLoading ? 'Agregando...' : 'Agregar'}
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}

      {showDeleteConfirm && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[9999] p-4">
          <div className="bg-dark-card rounded-2xl p-6 max-w-sm w-full space-y-4 border border-dark-border shadow-2xl">
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 bg-red-500/20 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </div>
              <h3 className="text-lg font-bold text-white mb-2">Eliminar instancia</h3>
              {(() => {
                const instanceToDelete = instances.find(i => i.id === showDeleteConfirm);
                return (
                  <p className="text-gray-400 text-sm">
                    {instanceToDelete?.provider === 'META_CLOUD' 
                      ? 'Esta accion eliminara la conexion con Meta Cloud API. Deberas volver a configurar las credenciales para reconectar.'
                      : 'Esta accion eliminara la sesion de WhatsApp Web. Deberas escanear el codigo QR nuevamente para reconectar.'}
                  </p>
                );
              })()}
            </div>
            
            <div className="p-3 bg-dark-surface rounded-lg border border-dark-border">
              {(() => {
                const instanceToDelete = instances.find(i => i.id === showDeleteConfirm);
                return instanceToDelete ? (
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${
                      instanceToDelete.status === 'open' || instanceToDelete.status === 'connected' 
                        ? 'bg-green-500' 
                        : 'bg-red-500'
                    }`} />
                    <div>
                      <p className="font-medium text-white text-sm">{instanceToDelete.name}</p>
                      <p className="text-xs text-gray-500">
                        {instanceToDelete.phoneNumber || 'Sin numero'} - {instanceToDelete.provider === 'META_CLOUD' ? 'Meta Cloud' : 'Baileys'}
                      </p>
                    </div>
                  </div>
                ) : null;
              })()}
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(null)}
                disabled={deleteLoading !== null}
                className="flex-1 px-4 py-2 bg-dark-surface border border-dark-border rounded-lg hover:bg-dark-hover transition-colors disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={(e) => handleDeleteInstance(showDeleteConfirm, e)}
                disabled={deleteLoading !== null}
                className="flex-1 px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {deleteLoading === showDeleteConfirm ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    Eliminando...
                  </>
                ) : (
                  'Eliminar'
                )}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showArchivedModal && createPortal(
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-dark-card rounded-2xl p-6 max-w-2xl w-full max-h-[80vh] overflow-auto">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-semibold text-white flex items-center gap-2">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                </svg>
                Instancias Archivadas
              </h3>
              <button
                onClick={() => setShowArchivedModal(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {archivedLoading ? (
              <div className="flex justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-neon-blue border-t-transparent"></div>
              </div>
            ) : archivedInstances.length === 0 ? (
              <div className="text-center py-12 text-gray-400">
                <svg className="w-12 h-12 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                </svg>
                <p>No hay instancias archivadas</p>
                <p className="text-sm mt-2">Las instancias eliminadas apareceran aqui</p>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-gray-400 mb-4">
                  Las instancias archivadas conservan todo el historial de mensajes. Puedes restaurarlas o eliminarlas permanentemente.
                </p>
                {archivedInstances.map((inst) => (
                  <div key={inst.id} className="bg-dark-surface border border-dark-border rounded-xl p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-gray-700 rounded-full flex items-center justify-center text-lg">
                          {inst.provider === 'META_CLOUD' ? '☁️' : inst.provider === 'META_COEXIST' ? '🔗' : '📱'}
                        </div>
                        <div>
                          <h4 className="font-medium text-white">{inst.name}</h4>
                          <p className="text-sm text-gray-400">
                            {inst.phoneNumber || 'Sin numero'} - {inst.provider}
                          </p>
                          <p className="text-xs text-gray-500">
                            Archivada: {new Date(inst.archivedAt).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' })}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 bg-dark-hover px-2 py-1 rounded">
                          {inst.messageCount || 0} mensajes
                        </span>
                        <button
                          onClick={() => handleRestoreInstance(inst.id)}
                          disabled={restoringId === inst.id}
                          className="px-3 py-1.5 bg-neon-blue/20 text-neon-blue hover:bg-neon-blue/30 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center gap-1"
                        >
                          {restoringId === inst.id ? (
                            <div className="w-4 h-4 border-2 border-neon-blue/30 border-t-neon-blue rounded-full animate-spin"></div>
                          ) : (
                            <>
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                              Restaurar
                            </>
                          )}
                        </button>
                        <button
                          onClick={() => setPermanentDeleteId(inst.id)}
                          className="px-3 py-1.5 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg text-sm transition-colors"
                        >
                          Eliminar
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>,
        document.body
      )}

      {permanentDeleteId && createPortal(
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-dark-card rounded-2xl p-6 max-w-md w-full">
            <h3 className="text-xl font-semibold text-white mb-4 flex items-center gap-2">
              <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              Eliminar Permanentemente
            </h3>
            <p className="text-gray-400 mb-6">
              Esta accion no se puede deshacer. La instancia sera eliminada permanentemente.
            </p>
            <div className="bg-yellow-900/20 border border-yellow-700/50 rounded-lg p-3 mb-6">
              <p className="text-yellow-400 text-sm">
                Puedes elegir si quieres eliminar tambien todos los mensajes asociados a esta instancia.
              </p>
            </div>
            <div className="flex flex-col gap-3">
              <button
                onClick={() => handlePermanentDelete(permanentDeleteId, false)}
                disabled={permanentDeleteLoading}
                className="w-full px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {permanentDeleteLoading ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                ) : (
                  'Eliminar (conservar mensajes)'
                )}
              </button>
              <button
                onClick={() => handlePermanentDelete(permanentDeleteId, true)}
                disabled={permanentDeleteLoading}
                className="w-full px-4 py-2 bg-red-700 hover:bg-red-800 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {permanentDeleteLoading ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                ) : (
                  'Eliminar TODO (incluir mensajes)'
                )}
              </button>
              <button
                onClick={() => setPermanentDeleteId(null)}
                disabled={permanentDeleteLoading}
                className="w-full px-4 py-2 bg-dark-surface border border-dark-border rounded-lg hover:bg-dark-hover transition-colors disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function ProviderSelector({ 
  selectedProvider, 
  setSelectedProvider 
}: { 
  selectedProvider: 'BAILEYS' | 'META_CLOUD' | 'META_COEXIST';
  setSelectedProvider: (provider: 'BAILEYS' | 'META_CLOUD' | 'META_COEXIST') => void;
}) {
  const { enableMetaCoexist } = useGlassStore();
  
  return (
    <div>
      <label className="block text-sm font-medium text-gray-400 mb-2">
        Tipo de conexion
      </label>
      <div className={`grid gap-3 ${enableMetaCoexist ? 'grid-cols-3' : 'grid-cols-2'}`}>
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
          <div className="font-medium text-white text-sm">WhatsApp QR</div>
          <div className="text-xs text-gray-400">Escanea con QR</div>
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
          <div className="font-medium text-white text-sm">Meta Cloud</div>
          <div className="text-xs text-gray-400">Config Manual</div>
        </button>
        {enableMetaCoexist && (
          <button
            type="button"
            onClick={() => setSelectedProvider('META_COEXIST')}
            className={`p-4 rounded-xl border-2 transition-all text-center ${
              selectedProvider === 'META_COEXIST'
                ? 'border-purple-500 bg-purple-500/10'
                : 'border-dark-border hover:border-gray-600'
            }`}
          >
            <div className="text-2xl mb-1">🔗</div>
            <div className="font-medium text-white text-sm">Coexistence</div>
            <div className="text-xs text-gray-400">Via Facebook OAuth</div>
          </button>
        )}
      </div>
    </div>
  );
}

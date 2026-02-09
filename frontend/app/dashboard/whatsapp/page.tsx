'use client';

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useBusinessStore } from '@/store/business';
import { useAuthStore } from '@/store/auth';
import { useInstanceStore, WhatsAppInstance } from '@/store/instance';
import api, { waApi, businessApi } from '@/lib/api';
import InstanceSelector from '@/components/InstanceSelector';
import MetaEmbeddedSignup from '@/components/MetaEmbeddedSignup';

interface ConnectionEvent {
  type: string;
  message: string;
  timestamp: Date;
}

interface InstanceHistoryEvent {
  id: string;
  eventType: string;
  previousProvider?: string;
  newProvider?: string;
  previousStatus?: string;
  newStatus?: string;
  phoneNumber?: string;
  details?: string;
  createdAt: string;
}

interface MetaFormData {
  name: string;
  accessToken: string;
  metaBusinessId: string;
  phoneNumberId: string;
  appId: string;
  appSecret: string;
  displayPhoneNumber: string;
}

const COUNTRY_CODES = [
  { code: '+1', country: 'USA/Canada', flag: '🇺🇸' },
  { code: '+52', country: 'Mexico', flag: '🇲🇽' },
  { code: '+34', country: 'España', flag: '🇪🇸' },
  { code: '+57', country: 'Colombia', flag: '🇨🇴' },
  { code: '+54', country: 'Argentina', flag: '🇦🇷' },
  { code: '+55', country: 'Brasil', flag: '🇧🇷' },
  { code: '+56', country: 'Chile', flag: '🇨🇱' },
  { code: '+51', country: 'Peru', flag: '🇵🇪' },
  { code: '+58', country: 'Venezuela', flag: '🇻🇪' },
  { code: '+593', country: 'Ecuador', flag: '🇪🇨' },
  { code: '+502', country: 'Guatemala', flag: '🇬🇹' },
  { code: '+503', country: 'El Salvador', flag: '🇸🇻' },
  { code: '+504', country: 'Honduras', flag: '🇭🇳' },
  { code: '+505', country: 'Nicaragua', flag: '🇳🇮' },
  { code: '+506', country: 'Costa Rica', flag: '🇨🇷' },
  { code: '+507', country: 'Panama', flag: '🇵🇦' },
  { code: '+591', country: 'Bolivia', flag: '🇧🇴' },
  { code: '+595', country: 'Paraguay', flag: '🇵🇾' },
  { code: '+598', country: 'Uruguay', flag: '🇺🇾' },
];

export default function WhatsAppPage() {
  const { currentBusiness, setCurrentBusiness } = useBusinessStore();
  const { user } = useAuthStore();
  const { 
    instances, 
    selectedInstanceId, 
    limits,
    getSelectedInstance,
    updateInstance,
    removeInstance,
    setSelectedInstanceId
  } = useInstanceStore();
  
  const isPro = user?.isPro || ['PRO', 'ENTERPRISE'].includes(limits?.tier || '');
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [provider, setProvider] = useState<string>('BAILEYS');
  const [qrCode, setQrCode] = useState<string>('');
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [error, setError] = useState('');
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [events, setEvents] = useState<ConnectionEvent[]>([]);
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [showPhoneInput, setShowPhoneInput] = useState(false);
  const [showMetaForm, setShowMetaForm] = useState(false);
  const [showReconnectModal, setShowReconnectModal] = useState(false);
  const [metaInfo, setMetaInfo] = useState<any>(null);
  const [webhookInfo, setWebhookInfo] = useState<{ url: string; token: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyEvents, setHistoryEvents] = useState<InstanceHistoryEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  
  const [countryCode, setCountryCode] = useState('+52');
  const [phoneInput, setPhoneInput] = useState('');
  
  const [apiConfig, setApiConfig] = useState<{
    apiKeyPrefix: string | null;
    webhookUrl: string | null;
    webhookSecret: string | null;
    webhookEvents: string[];
    hasApiKey: boolean;
  } | null>(null);
  const [apiConfigLoading, setApiConfigLoading] = useState(false);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [regeneratingKey, setRegeneratingKey] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState(false);
  const [webhookUrlInput, setWebhookUrlInput] = useState('');
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [showAdvancedWebhook, setShowAdvancedWebhook] = useState(false);
  const [webhookEventsInput, setWebhookEventsInput] = useState<string[]>([]);
  
  const [instanceSlug, setInstanceSlug] = useState('');
  const [instanceCatalogLogo, setInstanceCatalogLogo] = useState('');
  const [savingCatalog, setSavingCatalog] = useState(false);
  
  const [metaForm, setMetaForm] = useState<MetaFormData>({
    name: '',
    accessToken: '',
    metaBusinessId: '',
    phoneNumberId: '',
    appId: '',
    appSecret: '',
    displayPhoneNumber: ''
  });

  const addEvent = useCallback((type: string, message: string) => {
    setEvents(prev => [{
      type,
      message,
      timestamp: new Date()
    }, ...prev.slice(0, 9)]);
  }, []);

  const fetchApiConfig = useCallback(async () => {
    if (!currentBusiness || !selectedInstanceId) return;
    setApiConfigLoading(true);
    try {
      const response = await waApi.instanceApiConfig(selectedInstanceId, currentBusiness.id);
      setApiConfig(response.data);
      setWebhookUrlInput(response.data.webhookUrl || '');
      setWebhookEventsInput(response.data.webhookEvents || []);
    } catch (err) {
      console.error('Failed to fetch API config:', err);
      setApiConfig(null);
    } finally {
      setApiConfigLoading(false);
    }
  }, [currentBusiness, selectedInstanceId]);

  const handleRegenerateApiKey = async () => {
    if (!currentBusiness || !selectedInstanceId) return;
    if (!confirm('¿Regenerar la API key? La clave anterior dejará de funcionar.')) return;
    
    setRegeneratingKey(true);
    try {
      const response = await waApi.instanceRegenerateApiKey(selectedInstanceId, currentBusiness.id);
      setNewApiKey(response.data.apiKey);
      setApiConfig(prev => prev ? { ...prev, apiKeyPrefix: response.data.apiKeyPrefix, hasApiKey: true } : null);
      addEvent('success', 'API key regenerada');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al regenerar API key');
    } finally {
      setRegeneratingKey(false);
    }
  };

  const handleSaveWebhook = async (saveEvents = false) => {
    if (!currentBusiness || !selectedInstanceId) return;
    setSavingWebhook(true);
    try {
      const eventsToSend = saveEvents ? webhookEventsInput : undefined;
      const response = await waApi.instanceUpdateWebhook(selectedInstanceId, currentBusiness.id, webhookUrlInput || null, eventsToSend);
      setApiConfig(prev => prev ? { 
        ...prev, 
        webhookUrl: response.data.webhookUrl, 
        webhookSecret: response.data.webhookSecret,
        webhookEvents: response.data.webhookEvents || []
      } : null);
      setEditingWebhook(false);
      setShowAdvancedWebhook(false);
      addEvent('success', 'Webhook actualizado');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al guardar webhook');
    } finally {
      setSavingWebhook(false);
    }
  };
  
  const toggleWebhookEvent = (event: string) => {
    setWebhookEventsInput(prev => 
      prev.includes(event) ? prev.filter(e => e !== event) : [...prev, event]
    );
  };
  
  const WEBHOOK_EVENTS = [
    { id: 'user_message', label: 'Mensaje del usuario', desc: 'Cuando un contacto envía un mensaje' },
    { id: 'agent_message', label: 'Mensaje del agente', desc: 'Cuando el AI o tu equipo responde' },
    { id: 'stage_change', label: 'Cambio de etapa', desc: 'Cuando cambia la etapa del lead' },
    { id: 'state_change', label: 'Cambio de estado', desc: 'Cuando cambia el estado del contacto' },
    { id: 'tool_call', label: 'Ejecución de herramienta', desc: 'Cuando el AI ejecuta una herramienta' }
  ];

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const fetchStatus = useCallback(async () => {
    if (!currentBusiness) return;
    
    try {
      let response;
      if (selectedInstanceId) {
        response = await waApi.instanceStatus(selectedInstanceId, currentBusiness.id);
      } else {
        response = await waApi.status(currentBusiness.id);
      }
      const newStatus = response.data.status;
      
      if (newStatus !== status && status !== '') {
        addEvent('status', `Estado: ${getStatusText(newStatus)}`);
      }
      
      setStatus(newStatus);
      setProvider(response.data.provider || 'BAILEYS');
      setPhoneNumber(response.data.phoneNumber || '');
      setLastUpdate(new Date());
      
      if (response.data.metaInfo) {
        setMetaInfo(response.data.metaInfo);
      }
      if (response.data.webhookUrl && response.data.webhookVerifyToken) {
        setWebhookInfo({
          url: response.data.webhookUrl,
          token: response.data.webhookVerifyToken
        });
      }
      
      if ((newStatus === 'pending_qr' || newStatus === 'requires_qr') && response.data.provider !== 'META_CLOUD' && response.data.provider !== 'META_COEXIST') {
        let qrResponse;
        if (selectedInstanceId) {
          qrResponse = await waApi.instanceQr(selectedInstanceId, currentBusiness.id);
        } else {
          qrResponse = await waApi.qr(currentBusiness.id);
        }
        setQrCode(qrResponse.data.qr || '');
      } else {
        setQrCode('');
      }
    } catch (err: any) {
      if (err.response?.status === 404) {
        if (selectedInstanceId) {
          setStatus('disconnected');
        } else {
          setStatus('not_created');
        }
      }
    }
  }, [currentBusiness, selectedInstanceId, status, addEvent]);

  const getStatusText = (s: string) => {
    const texts: Record<string, string> = {
      'not_created': 'Sin configurar',
      'pending_qr': 'Esperando QR',
      'requires_qr': 'Esperando QR',
      'open': 'Conectado',
      'connected': 'Conectado',
      'closed': 'Desconectado',
      'disconnected': 'Desconectado',
      'connecting': 'Conectando',
      'error': 'Error'
    };
    return texts[s] || s;
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  useEffect(() => {
    if (selectedInstanceId && viewMode === 'detail') {
      fetchApiConfig();
      setNewApiKey(null);
    }
  }, [selectedInstanceId, viewMode, fetchApiConfig]);

  const handleSelectBaileys = () => {
    setShowProviderModal(false);
    setShowPhoneInput(true);
  };

  const handleCreateBaileys = async () => {
    if (!currentBusiness) return;
    
    const fullPhone = phoneInput ? `${countryCode.replace('+', '')}${phoneInput.replace(/\D/g, '')}` : '';
    
    if (!fullPhone) {
      setError('Por favor ingresa tu numero de telefono');
      return;
    }
    
    setLoading(true);
    setError('');
    setShowPhoneInput(false);
    addEvent('action', 'Creando instancia Baileys...');
    
    try {
      let newInstanceId: string | null = null;
      
      // Check existing instances from business (more reliable than store)
      const existingInstances = currentBusiness.instances || [];
      
      // If instances already exist, use addInstance to create a new one instead of replacing
      if (existingInstances.length > 0) {
        const response = await waApi.addInstance({
          businessId: currentBusiness.id,
          provider: 'BAILEYS',
          phoneNumber: fullPhone,
          name: `WhatsApp ${existingInstances.length + 1}`
        });
        newInstanceId = response.data.instance?.id;
        addEvent('success', 'Nueva instancia Baileys agregada');
      } else {
        const response = await waApi.create(currentBusiness.id, fullPhone);
        newInstanceId = response.data.instance?.id;
        addEvent('success', 'Instancia Baileys creada');
      }
      
      const refreshed = await businessApi.get(currentBusiness.id);
      setCurrentBusiness(refreshed.data);
      
      // Select the new instance to show its QR
      if (newInstanceId) {
        setSelectedInstanceId(newInstanceId);
      } else if (refreshed.data.instances?.length > 0) {
        // Find the newest Baileys instance
        const baileysInstances = refreshed.data.instances.filter((i: any) => i.provider === 'BAILEYS');
        if (baileysInstances.length > 0) {
          const newest = baileysInstances[baileysInstances.length - 1];
          setSelectedInstanceId(newest.id);
        }
      }
      
      await fetchStatus();
      setPhoneInput('');
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Error al crear instancia';
      setError(errorMsg);
      addEvent('error', errorMsg);
      setShowPhoneInput(true);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateMeta = async () => {
    if (!currentBusiness) return;
    
    if (!metaForm.accessToken || !metaForm.metaBusinessId || !metaForm.phoneNumberId || !metaForm.appId || !metaForm.appSecret) {
      setError('Todos los campos son obligatorios');
      return;
    }
    
    if (!metaForm.displayPhoneNumber) {
      setError('El numero de telefono es obligatorio');
      return;
    }
    
    setLoading(true);
    setError('');
    addEvent('action', 'Creando instancia Meta Cloud...');
    
    try {
      let response;
      let newInstanceId: string | null = null;
      
      // Check existing instances from business
      const existingInstances = currentBusiness.instances || [];
      
      // If instances already exist, use addInstance to create a new one instead of replacing
      if (existingInstances.length > 0) {
        response = await waApi.addInstance({
          businessId: currentBusiness.id,
          provider: 'META_CLOUD',
          name: metaForm.name || 'Meta WhatsApp',
          phoneNumber: metaForm.displayPhoneNumber.replace(/\D/g, ''),
          metaCredentials: {
            accessToken: metaForm.accessToken,
            wabaId: metaForm.metaBusinessId,
            phoneNumberId: metaForm.phoneNumberId,
            appId: metaForm.appId,
            appSecret: metaForm.appSecret
          }
        });
        newInstanceId = response.data.instance?.id;
        addEvent('success', 'Nueva instancia Meta Cloud agregada');
      } else {
        response = await waApi.createMeta({
          businessId: currentBusiness.id,
          name: metaForm.name || 'Meta WhatsApp',
          accessToken: metaForm.accessToken,
          metaBusinessId: metaForm.metaBusinessId,
          phoneNumberId: metaForm.phoneNumberId,
          appId: metaForm.appId,
          appSecret: metaForm.appSecret,
          phoneNumber: metaForm.displayPhoneNumber.replace(/\D/g, '')
        });
        newInstanceId = response.data.instance?.id;
        addEvent('success', 'Instancia Meta Cloud creada');
      }
      
      setShowMetaForm(false);
      setShowProviderModal(false);
      
      if (response.data.webhookUrl) {
        setWebhookInfo({
          url: response.data.webhookUrl,
          token: response.data.instance?.webhookVerifyToken || response.data.webhookVerifyToken
        });
      }
      
      const refreshed = await businessApi.get(currentBusiness.id);
      setCurrentBusiness(refreshed.data);
      
      // Select the new instance
      if (newInstanceId) {
        setSelectedInstanceId(newInstanceId);
      } else if (refreshed.data.instances?.length > 0) {
        const metaInstances = refreshed.data.instances.filter((i: any) => i.provider === 'META_CLOUD');
        if (metaInstances.length > 0) {
          const newest = metaInstances[metaInstances.length - 1];
          setSelectedInstanceId(newest.id);
        }
      }
      
      await fetchStatus();
      
      setMetaForm({
        name: '',
        accessToken: '',
        metaBusinessId: '',
        phoneNumberId: '',
        appId: '',
        appSecret: '',
        displayPhoneNumber: ''
      });
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Error al crear instancia Meta';
      const details = err.response?.data?.details;
      setError(details ? `${errorMsg}: ${details}` : errorMsg);
      addEvent('error', errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleStartCoexistence = async () => {
    if (!currentBusiness) return;
    
    setLoading(true);
    setError('');
    setShowProviderModal(false);
    addEvent('action', 'Iniciando conexion Meta Coexistence...');
    
    try {
      const response = await waApi.startMetaCoexist(currentBusiness.id);
      const authUrl = response.data.redirectUrl || response.data.authUrl;
      if (authUrl) {
        window.location.href = authUrl;
      } else {
        throw new Error('No se recibio URL de autorizacion');
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Error al iniciar Meta Coexistence';
      setError(errorMsg);
      addEvent('error', errorMsg);
      setShowProviderModal(true);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateMetaCredentials = async () => {
    if (!currentBusiness || !selectedInstanceId) return;
    
    if (!metaForm.accessToken || !metaForm.metaBusinessId || !metaForm.phoneNumberId || !metaForm.appId || !metaForm.appSecret) {
      setError('Todos los campos son obligatorios');
      return;
    }
    
    if (!metaForm.displayPhoneNumber) {
      setError('El numero de telefono es obligatorio');
      return;
    }
    
    setLoading(true);
    setError('');
    addEvent('action', 'Guardando credenciales Meta Cloud...');
    
    try {
      const response = await waApi.updateMetaCredentials(selectedInstanceId, currentBusiness.id, {
        accessToken: metaForm.accessToken,
        metaBusinessId: metaForm.metaBusinessId,
        phoneNumberId: metaForm.phoneNumberId,
        appId: metaForm.appId,
        appSecret: metaForm.appSecret,
        phoneNumber: metaForm.displayPhoneNumber.replace(/\D/g, '')
      });
      
      addEvent('success', 'Credenciales guardadas');
      
      if (response.data.webhookUrl) {
        setWebhookInfo({
          url: response.data.webhookUrl,
          token: response.data.webhookVerifyToken
        });
      }
      
      await fetchStatus();
      
      setMetaForm({
        name: '',
        accessToken: '',
        metaBusinessId: '',
        phoneNumberId: '',
        appId: '',
        appSecret: '',
        displayPhoneNumber: ''
      });
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Error al guardar credenciales';
      const details = err.response?.data?.details;
      setError(details ? `${errorMsg}: ${details}` : errorMsg);
      addEvent('error', errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleRefreshQR = async () => {
    if (!currentBusiness) return;
    
    setActionLoading('qr');
    setError('');
    addEvent('action', 'Refrescando QR...');
    
    try {
      let qrResponse;
      if (selectedInstanceId) {
        qrResponse = await waApi.instanceQr(selectedInstanceId, currentBusiness.id);
      } else {
        qrResponse = await waApi.qr(currentBusiness.id);
      }
      setQrCode(qrResponse.data.qr || '');
      setLastUpdate(new Date());
      addEvent('success', 'QR actualizado');
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Error al obtener QR';
      setError(errorMsg);
      addEvent('error', errorMsg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRestart = async () => {
    if (!currentBusiness) return;
    
    setActionLoading('restart');
    setError('');
    addEvent('action', 'Reiniciando conexion...');
    
    try {
      if (selectedInstanceId) {
        await waApi.instanceRestart(selectedInstanceId, currentBusiness.id);
      } else {
        await waApi.restart(currentBusiness.id);
      }
      addEvent('success', 'Conexion reiniciada');
      await fetchStatus();
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Error al reiniciar';
      setError(errorMsg);
      addEvent('error', errorMsg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReset = async () => {
    if (!currentBusiness) return;
    if (!confirm('Cambiar numero de WhatsApp? Se desconectara el numero actual y deberas escanear el QR con el nuevo telefono.')) return;
    
    setActionLoading('reset');
    setError('');
    addEvent('action', 'Cambiando numero...');
    
    try {
      if (selectedInstanceId) {
        await waApi.instanceReset(selectedInstanceId, currentBusiness.id);
      } else {
        await waApi.reset(currentBusiness.id);
      }
      addEvent('success', 'Sesion reseteada. Escanea el QR con tu nuevo numero.');
      await fetchStatus();
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Error al cambiar numero';
      setError(errorMsg);
      addEvent('error', errorMsg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    if (!currentBusiness) return;
    if (!confirm('Eliminar esta conexion de WhatsApp? Tendras que configurar de nuevo.')) return;
    
    setActionLoading('delete');
    setError('');
    addEvent('action', 'Eliminando instancia...');
    
    try {
      if (selectedInstanceId) {
        await waApi.deleteInstance(selectedInstanceId, currentBusiness.id);
      } else {
        await waApi.delete(currentBusiness.id);
      }
      addEvent('success', 'Instancia eliminada');
      
      if (selectedInstanceId) {
        removeInstance(selectedInstanceId);
      }
      setSelectedInstanceId(null);
      setViewMode('list');
      setStatus('not_created');
      setQrCode('');
      setPhoneNumber('');
      setMetaInfo(null);
      setWebhookInfo(null);
      
      const refreshed = await businessApi.get(currentBusiness.id);
      setCurrentBusiness(refreshed.data);
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Error al eliminar';
      setError(errorMsg);
      addEvent('error', errorMsg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRegisterWebhook = async () => {
    if (!selectedInstanceId) return;
    
    setActionLoading('webhook');
    setError('');
    addEvent('action', 'Registrando webhooks con Meta...');
    
    try {
      const response = await api.post(`/auth/meta-coexist/webhook-register/${selectedInstanceId}`);
      if (response.data.success) {
        addEvent('success', 'Webhooks registrados correctamente. Meta ahora enviara eventos a tu instancia.');
      } else {
        addEvent('warning', response.data.message || 'Registro enviado pero estado incierto');
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Error al registrar webhooks';
      setError(errorMsg);
      addEvent('error', errorMsg);
    } finally {
      setActionLoading(null);
    }
  };

  const getStatusBadge = () => {
    const badges: Record<string, { bg: string; dot: string; text: string }> = {
      'not_created': { bg: 'bg-gray-700', dot: 'bg-gray-400', text: 'Sin configurar' },
      'pending_qr': { bg: 'bg-accent-warning/20', dot: 'bg-accent-warning', text: 'Esperando QR' },
      'requires_qr': { bg: 'bg-accent-warning/20', dot: 'bg-accent-warning', text: 'Esperando QR' },
      'open': { bg: 'bg-accent-success/20', dot: 'bg-accent-success', text: 'Conectado' },
      'connected': { bg: 'bg-accent-success/20', dot: 'bg-accent-success', text: 'Conectado' },
      'closed': { bg: 'bg-accent-error/20', dot: 'bg-accent-error', text: 'Desconectado' },
      'disconnected': { bg: 'bg-accent-error/20', dot: 'bg-accent-error', text: 'Desconectado' },
      'connecting': { bg: 'bg-neon-blue/20', dot: 'bg-neon-blue', text: 'Conectando' },
      'error': { bg: 'bg-accent-error/20', dot: 'bg-accent-error', text: 'Error' }
    };
    const badge = badges[status] || { bg: 'bg-gray-700', dot: 'bg-gray-400', text: status };
    return (
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-white ${badge.bg}`}>
        <span className={`w-2 h-2 rounded-full ${badge.dot} ${status === 'open' || status === 'connected' ? 'animate-pulse' : ''}`}></span>
        {badge.text}
      </span>
    );
  };

  const getProviderBadge = () => {
    if (provider === 'META_CLOUD') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-neon-blue/20 text-neon-blue">
          <span>📱</span> Meta Cloud API
        </span>
      );
    }
    if (provider === 'META_COEXIST') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-purple-500/20 text-purple-400">
          <span>🔗</span> Meta Coexist
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-accent-success/20 text-accent-success">
        <span>📲</span> Baileys
      </span>
    );
  };

  const getEventIcon = (type: string) => {
    switch (type) {
      case 'success': return '✓';
      case 'error': return '✕';
      case 'action': return '→';
      case 'status': return '●';
      default: return '•';
    }
  };

  const getEventColor = (type: string) => {
    switch (type) {
      case 'success': return 'text-accent-success';
      case 'error': return 'text-accent-error';
      case 'action': return 'text-neon-blue';
      case 'status': return 'text-gray-400';
      default: return 'text-gray-500';
    }
  };


  const fetchHistory = async () => {
    if (!currentBusiness) return;
    setHistoryLoading(true);
    try {
      const response = await waApi.history(currentBusiness.id, 20);
      setHistoryEvents(response.data || []);
    } catch (err) {
      console.error('Failed to fetch history:', err);
    } finally {
      setHistoryLoading(false);
    }
  };

  const formatEventType = (eventType: string) => {
    const labels: Record<string, string> = {
      CREATED: 'Instancia creada',
      CONNECTED: 'Conectado',
      DISCONNECTED: 'Desconectado',
      PROVIDER_CHANGED: 'Proveedor cambiado',
      DELETED: 'Eliminado',
      RECONNECTED: 'Reconectado',
      QR_GENERATED: 'QR generado',
      SESSION_EXPIRED: 'Sesion expirada',
      ERROR: 'Error'
    };
    return labels[eventType] || eventType;
  };

  const getHistoryEventIcon = (eventType: string) => {
    const icons: Record<string, string> = {
      CREATED: '✚',
      CONNECTED: '✓',
      DISCONNECTED: '✕',
      PROVIDER_CHANGED: '↻',
      DELETED: '🗑',
      RECONNECTED: '↺',
      QR_GENERATED: '◐',
      SESSION_EXPIRED: '⏱',
      ERROR: '⚠'
    };
    return icons[eventType] || '•';
  };

  const getHistoryEventColor = (eventType: string) => {
    const colors: Record<string, string> = {
      CREATED: 'text-neon-blue',
      CONNECTED: 'text-accent-success',
      DISCONNECTED: 'text-accent-error',
      PROVIDER_CHANGED: 'text-accent-warning',
      DELETED: 'text-gray-400',
      RECONNECTED: 'text-neon-blue',
      QR_GENERATED: 'text-gray-400',
      SESSION_EXPIRED: 'text-accent-error',
      ERROR: 'text-accent-error'
    };
    return colors[eventType] || 'text-gray-400';
  };

  if (!currentBusiness) {
    return (
      <div className="card text-center py-8">
        <p className="text-gray-400">Primero debes crear una empresa para conectar WhatsApp.</p>
      </div>
    );
  }

  const selectedInstance = getSelectedInstance();

  return (
    <div className="p-4 sm:p-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl sm:text-2xl font-bold text-white">WhatsApp</h1>
          {viewMode === 'detail' && selectedInstance && (
            <button 
              onClick={() => setViewMode('list')}
              className="text-sm text-neon-blue hover:text-neon-blue/80 flex items-center gap-1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Ver todos
            </button>
          )}
          {viewMode === 'detail' && status !== 'not_created' && (
            <>
              {getStatusBadge()}
              {getProviderBadge()}
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          {viewMode === 'detail' && phoneNumber && (status === 'open' || status === 'connected') && (
            <span className="text-sm text-gray-400">+{phoneNumber}</span>
          )}
          {viewMode === 'detail' && status !== 'not_created' && selectedInstanceId && (
            <button 
              onClick={handleDelete}
              disabled={actionLoading !== null}
              className="px-3 py-1.5 text-sm text-red-400 hover:text-white hover:bg-red-500 border border-red-500/50 hover:border-red-500 rounded-lg transition-all flex items-center gap-2"
              title="Eliminar instancia"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              <span className="hidden sm:inline">{actionLoading === 'delete' ? 'Eliminando...' : 'Eliminar'}</span>
            </button>
          )}
        </div>
      </div>

      {viewMode === 'list' && (
        <div className="card mb-6">
          <InstanceSelector 
            businessId={currentBusiness.id}
            onInstanceSelect={(instance) => {
              setViewMode('detail');
              setStatus(instance.status);
              setProvider(instance.provider);
              setPhoneNumber(instance.phoneNumber || '');
              setInstanceSlug((instance as any).slug || '');
              setInstanceCatalogLogo((instance as any).catalogLogoUrl || '');
              if ((instance.status === 'pending_qr' || instance.status === 'requires_qr') && instance.provider !== 'META_CLOUD' && instance.provider !== 'META_COEXIST') {
                waApi.qr(currentBusiness.id).then(res => setQrCode(res.data.qr || '')).catch(() => {});
              }
            }}
            onInstanceDeleted={() => {
              setStatus('not_created');
              setPhoneNumber('');
              setQrCode('');
              setMetaInfo(null);
              setWebhookInfo(null);
            }}
            showAddButton={true}
          />
        </div>
      )}

      {viewMode === 'detail' && (
        <>
          {error && (
            <div className="bg-accent-error/10 border border-accent-error/20 text-accent-error px-3 py-2 rounded-lg mb-3 flex items-center justify-between text-sm">
              <span>{error}</span>
              <button onClick={() => setError('')} className="text-accent-error/70 hover:text-accent-error ml-2">✕</button>
            </div>
          )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <div className="card">
            {status === 'not_created' && (
              <div className="text-center py-6">
                <div className="text-4xl mb-3">💬</div>
                <h2 className="text-lg font-semibold text-white mb-1">Conecta tu WhatsApp</h2>
                <p className="text-gray-400 text-sm mb-4">Elige como quieres conectar tu cuenta de WhatsApp.</p>
                {user?.emailVerified === false ? (
                  <div className="bg-accent-warning/10 border border-accent-warning/20 rounded-lg p-4 max-w-sm mx-auto">
                    <p className="text-accent-warning text-sm mb-2">Verifica tu correo electrónico para crear instancias de WhatsApp</p>
                    <p className="text-gray-500 text-xs">Revisa tu bandeja de entrada o spam</p>
                  </div>
                ) : (
                  <button onClick={() => setShowProviderModal(true)} disabled={loading} className="btn btn-primary">
                    {loading ? 'Creando...' : 'Crear instancia'}
                  </button>
                )}
              </div>
            )}

            {status === 'pending_credentials' && provider === 'META_COEXIST' && (
              <div className="py-4">
                <div className="text-center mb-4">
                  <div className="text-3xl mb-2">🔗</div>
                  <h2 className="text-lg font-semibold text-white mb-1">Configurando Meta Coexistence</h2>
                  <p className="text-gray-400 text-sm">Tu conexion via Facebook OAuth se esta procesando</p>
                </div>
                
                <div className="max-w-md mx-auto">
                  <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-4 mb-4">
                    <div className="flex items-center gap-3">
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-purple-400"></div>
                      <p className="text-sm text-purple-300">Esperando confirmacion de Facebook...</p>
                    </div>
                  </div>
                  
                  <div className="flex gap-2">
                    <button
                      onClick={handleDelete}
                      disabled={actionLoading !== null}
                      className="btn btn-danger flex-1"
                    >
                      {actionLoading === 'delete' ? '...' : 'Cancelar y eliminar'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {status === 'pending_credentials' && provider === 'META_CLOUD' && (
              <div className="py-4">
                <div className="text-center mb-4">
                  <div className="text-3xl mb-2">☁️</div>
                  <h2 className="text-lg font-semibold text-white mb-1">Configura Meta Cloud API</h2>
                  <p className="text-gray-400 text-sm">Ingresa las credenciales de tu cuenta de Meta Business</p>
                </div>
                
                <div className="max-w-md mx-auto space-y-3">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Access Token *</label>
                    <input
                      type="password"
                      value={metaForm.accessToken}
                      onChange={(e) => setMetaForm({ ...metaForm, accessToken: e.target.value })}
                      className="input w-full text-sm"
                      placeholder="EAAxxxxxx..."
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Meta Business ID *</label>
                    <input
                      type="text"
                      value={metaForm.metaBusinessId}
                      onChange={(e) => setMetaForm({ ...metaForm, metaBusinessId: e.target.value })}
                      className="input w-full text-sm"
                      placeholder="123456789012345"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Phone Number ID *</label>
                    <input
                      type="text"
                      value={metaForm.phoneNumberId}
                      onChange={(e) => setMetaForm({ ...metaForm, phoneNumberId: e.target.value })}
                      className="input w-full text-sm"
                      placeholder="123456789012345"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">App ID *</label>
                    <input
                      type="text"
                      value={metaForm.appId}
                      onChange={(e) => setMetaForm({ ...metaForm, appId: e.target.value })}
                      className="input w-full text-sm"
                      placeholder="123456789012345"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">App Secret *</label>
                    <input
                      type="password"
                      value={metaForm.appSecret}
                      onChange={(e) => setMetaForm({ ...metaForm, appSecret: e.target.value })}
                      className="input w-full text-sm"
                      placeholder="abc123..."
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Numero de telefono *</label>
                    <input
                      type="text"
                      value={metaForm.displayPhoneNumber}
                      onChange={(e) => setMetaForm({ ...metaForm, displayPhoneNumber: e.target.value })}
                      className="input w-full text-sm"
                      placeholder="+521234567890"
                    />
                  </div>
                  
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={handleUpdateMetaCredentials}
                      disabled={loading}
                      className="btn btn-primary flex-1"
                    >
                      {loading ? 'Guardando...' : 'Guardar credenciales'}
                    </button>
                    <button
                      onClick={handleDelete}
                      disabled={actionLoading !== null}
                      className="btn btn-danger"
                    >
                      {actionLoading === 'delete' ? '...' : 'Eliminar'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {(status === 'pending_qr' || status === 'requires_qr') && provider !== 'META_CLOUD' && provider !== 'META_COEXIST' && (
              <div className="py-2">
                <div className="text-center mb-3">
                  <h2 className="text-lg font-semibold text-white">Escanea el codigo QR</h2>
                  <p className="text-gray-500 text-xs">WhatsApp → Menu → Dispositivos vinculados → Vincular</p>
                </div>
                
                <div className="flex justify-center mb-3">
                  {qrCode ? (
                    <div className="relative p-2 bg-white rounded-lg">
                      <img src={qrCode} alt="QR Code" className="w-48 h-48" />
                      {actionLoading === 'qr' && (
                        <div className="absolute inset-0 bg-white/80 flex items-center justify-center rounded-lg">
                          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-neon-blue"></div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="w-48 h-48 bg-dark-hover rounded-lg flex items-center justify-center">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-neon-blue"></div>
                    </div>
                  )}
                </div>

                {lastUpdate && (
                  <p className="text-center text-xs text-gray-500 mb-3">
                    Actualizado: {lastUpdate.toLocaleTimeString()}
                  </p>
                )}

                <div className="flex flex-wrap justify-center gap-2">
                  <button onClick={handleRefreshQR} disabled={actionLoading !== null} className="btn btn-secondary btn-sm">
                    {actionLoading === 'qr' ? '...' : 'Refrescar'}
                  </button>
                  <button onClick={handleRestart} disabled={actionLoading !== null} className="btn btn-secondary btn-sm">
                    {actionLoading === 'restart' ? '...' : 'Reiniciar'}
                  </button>
                  <button onClick={handleDelete} disabled={actionLoading !== null} className="btn btn-danger btn-sm">
                    {actionLoading === 'delete' ? '...' : 'Eliminar'}
                  </button>
                </div>
              </div>
            )}

            {(status === 'open' || status === 'connected') && (
              <div className="py-2">
                <div className="flex items-center gap-3 p-3 bg-accent-success/10 border border-accent-success/20 rounded-lg mb-4">
                  <div className="w-10 h-10 bg-accent-success/20 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-xl text-accent-success">✓</span>
                  </div>
                  <div className="flex-1">
                    <h2 className="font-semibold text-white">WhatsApp Conectado</h2>
                    <p className="text-xs text-gray-400">Tu cuenta esta activa y recibiendo mensajes</p>
                    {metaInfo && (
                      <p className="text-xs text-neon-blue mt-1">
                        {metaInfo.verifiedName && `Nombre: ${metaInfo.verifiedName}`}
                        {metaInfo.qualityRating && ` - Calidad: ${metaInfo.qualityRating}`}
                      </p>
                    )}
                  </div>
                </div>

                {provider === 'META_CLOUD' && webhookInfo && (
                  <div className="bg-neon-blue/10 border border-neon-blue/30 p-3 rounded-lg mb-4">
                    <h3 className="text-sm font-semibold text-neon-blue mb-2">Configuracion de Webhook</h3>
                    <div className="space-y-2">
                      <div>
                        <label className="text-xs text-neon-blue/70">URL del Webhook:</label>
                        <div className="flex items-center gap-2">
                          <code className="text-xs bg-dark-hover text-gray-300 px-2 py-1 rounded flex-1 overflow-x-auto">{webhookInfo.url}</code>
                          <button onClick={() => copyToClipboard(webhookInfo.url, 'webhookUrl')} className="text-neon-blue hover:text-cyan-400 text-xs">{copiedField === 'webhookUrl' ? '✓' : '📋'}</button>
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-neon-blue/70">Token de verificacion:</label>
                        <div className="flex items-center gap-2">
                          <code className="text-xs bg-dark-hover text-gray-300 px-2 py-1 rounded flex-1">{webhookInfo.token}</code>
                          <button onClick={() => copyToClipboard(webhookInfo.token, 'webhookToken')} className="text-neon-blue hover:text-cyan-400 text-xs">{copiedField === 'webhookToken' ? '✓' : '📋'}</button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {provider === 'META_COEXIST' && (
                  <div className="bg-purple-500/10 border border-purple-500/30 p-3 rounded-lg mb-4">
                    <h3 className="text-sm font-semibold text-purple-400 mb-2">Meta Coexistence Activo</h3>
                    <div className="space-y-2">
                      <p className="text-xs text-gray-400">
                        Tu WhatsApp Business App esta conectada via Meta Coexistence. 
                        Puedes enviar y recibir mensajes a traves del API mientras mantienes el uso de tu app de WhatsApp Business.
                      </p>
                      {metaInfo && (
                        <div className="mt-2 pt-2 border-t border-purple-500/20 space-y-1">
                          {metaInfo.displayPhoneNumber && (
                            <p className="text-xs text-purple-300">Telefono: {metaInfo.displayPhoneNumber}</p>
                          )}
                          {metaInfo.phoneNumberId && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-purple-300">Phone Number ID:</span>
                              <code className="text-xs bg-purple-500/20 text-purple-200 px-1.5 py-0.5 rounded font-mono">{metaInfo.phoneNumberId}</code>
                              <button 
                                onClick={() => copyToClipboard(metaInfo.phoneNumberId, 'phoneNumberId')} 
                                className="text-purple-400 hover:text-purple-300 text-xs"
                              >
                                {copiedField === 'phoneNumberId' ? '✓' : '📋'}
                              </button>
                            </div>
                          )}
                          {!metaInfo.phoneNumberId && (
                            <p className="text-xs text-red-400">
                              ⚠️ Phone Number ID no configurado - Los webhooks no funcionaran hasta que se repare
                            </p>
                          )}
                          {metaInfo.wabaId && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-purple-300">WABA ID:</span>
                              <code className="text-xs bg-purple-500/20 text-purple-200 px-1.5 py-0.5 rounded font-mono">{metaInfo.wabaId}</code>
                              <button 
                                onClick={() => copyToClipboard(metaInfo.wabaId, 'wabaId')} 
                                className="text-purple-400 hover:text-purple-300 text-xs"
                              >
                                {copiedField === 'wabaId' ? '✓' : '📋'}
                              </button>
                            </div>
                          )}
                          {metaInfo.verifiedName && (
                            <p className="text-xs text-purple-300">Nombre verificado: {metaInfo.verifiedName}</p>
                          )}
                          {metaInfo.qualityRating && (
                            <p className="text-xs text-purple-300">Calidad: {metaInfo.qualityRating}</p>
                          )}
                          {metaInfo.messagingTier && (
                            <p className="text-xs text-purple-300">Limite de mensajes: {metaInfo.messagingTier}</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                
                <div className="mt-4 pt-4 border-t border-dark-border">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs text-gray-500">Acciones para</span>
                    {provider === 'META_CLOUD' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-neon-blue/20 text-neon-blue">
                        ☁️ Meta Cloud
                      </span>
                    ) : provider === 'META_COEXIST' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-purple-500/20 text-purple-400">
                        🔗 Meta Coexist
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-accent-success/20 text-accent-success">
                        📲 Baileys
                      </span>
                    )}
                  </div>
                  
                  <div className="flex flex-wrap gap-2">
                    {provider === 'META_CLOUD' ? (
                      <button 
                        onClick={() => setShowMetaForm(true)} 
                        disabled={actionLoading !== null} 
                        className="btn btn-secondary btn-sm flex items-center gap-1"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                        Editar credenciales
                      </button>
                    ) : provider === 'META_COEXIST' ? (
                      <>
                        <button onClick={handleRegisterWebhook} disabled={actionLoading !== null} className="btn btn-primary btn-sm flex items-center gap-1">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          {actionLoading === 'webhook' ? '...' : 'Activar Webhooks'}
                        </button>
                        <button onClick={handleRestart} disabled={actionLoading !== null} className="btn btn-secondary btn-sm flex items-center gap-1">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          {actionLoading === 'restart' ? '...' : 'Sincronizar'}
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={handleRestart} disabled={actionLoading !== null} className="btn btn-secondary btn-sm flex items-center gap-1">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          {actionLoading === 'restart' ? '...' : 'Reiniciar sesion'}
                        </button>
                        <button onClick={handleReset} disabled={actionLoading !== null} className="btn btn-warning btn-sm flex items-center gap-1">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                          </svg>
                          {actionLoading === 'reset' ? '...' : 'Cambiar numero'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {(status === 'closed' || status === 'disconnected') && (
              <div className="py-2">
                <div className="flex items-center gap-3 p-3 bg-accent-error/10 border border-accent-error/20 rounded-lg mb-4">
                  <div className="w-10 h-10 bg-accent-error/20 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-xl">⚠️</span>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="font-semibold text-white">Conexion perdida</h2>
                      {provider === 'META_CLOUD' ? (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-neon-blue/20 text-neon-blue">Meta Cloud</span>
                      ) : provider === 'META_COEXIST' ? (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">Meta Coexist</span>
                      ) : (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-accent-success/20 text-accent-success">Baileys</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400">
                      {provider === 'META_CLOUD' 
                        ? 'Verifica las credenciales de Meta o elimina para configurar de nuevo'
                        : provider === 'META_COEXIST'
                        ? 'La conexion con Facebook se perdio. Usa el boton Reconectar para renovar la autorizacion.'
                        : 'Reconecta escaneando el QR o elimina para empezar de nuevo'}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {provider === 'META_CLOUD' ? (
                    <button 
                      onClick={() => setShowMetaForm(true)} 
                      disabled={actionLoading !== null} 
                      className="btn btn-primary btn-sm flex items-center gap-1"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                      Revisar credenciales
                    </button>
                  ) : provider === 'META_COEXIST' ? (
                    <>
                      <button 
                        onClick={() => setShowReconnectModal(true)} 
                        disabled={actionLoading !== null} 
                        className="btn btn-primary btn-sm flex items-center gap-1"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Reconectar
                      </button>
                      <button onClick={handleDelete} disabled={actionLoading !== null} className="btn btn-danger btn-sm flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        Eliminar
                      </button>
                    </>
                  ) : (
                    <button onClick={handleRestart} disabled={actionLoading !== null} className="btn btn-primary btn-sm flex items-center gap-1">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      {actionLoading === 'restart' ? '...' : 'Reconectar'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {status === 'connecting' && (
              <div className="text-center py-6">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-neon-blue mx-auto mb-3"></div>
                <h2 className="font-semibold text-white">Conectando...</h2>
                <p className="text-gray-400 text-xs">Estableciendo conexion con WhatsApp</p>
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-1 space-y-4">
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
              <span>📋</span> Actividad
            </h3>
            
            {events.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-4">Sin actividad reciente</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {events.map((event, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className={`${getEventColor(event.type)} flex-shrink-0`}>
                      {getEventIcon(event.type)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-300 truncate">{event.message}</p>
                      <p className="text-gray-500">{event.timestamp.toLocaleTimeString()}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {selectedInstanceId && (status === 'open' || status === 'connected') && (
            <div className="card">
              <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                <span>🎯</span> Objetivo
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={async () => {
                    if (currentBusiness && selectedInstanceId) {
                      await waApi.updateInstance(selectedInstanceId, currentBusiness.id, { businessObjective: 'SALES' });
                      updateInstance(selectedInstanceId, { businessObjective: 'SALES' } as any);
                    }
                  }}
                  className={`p-3 rounded-lg border-2 text-center transition-all text-xs font-medium ${
                    selectedInstance?.businessObjective === 'SALES' || !selectedInstance?.businessObjective
                      ? 'border-accent-success bg-accent-success/20 text-accent-success ring-1 ring-accent-success/50'
                      : 'border-dark-border bg-dark-hover text-gray-400 hover:border-gray-500'
                  }`}
                >
                  <span className="block text-lg mb-1">🛒</span>
                  Ventas
                </button>
                <button
                  onClick={async () => {
                    if (currentBusiness && selectedInstanceId) {
                      await waApi.updateInstance(selectedInstanceId, currentBusiness.id, { businessObjective: 'APPOINTMENTS' });
                      updateInstance(selectedInstanceId, { businessObjective: 'APPOINTMENTS' } as any);
                    }
                  }}
                  className={`p-3 rounded-lg border-2 text-center transition-all text-xs font-medium ${
                    selectedInstance?.businessObjective === 'APPOINTMENTS'
                      ? 'border-accent-success bg-accent-success/20 text-accent-success ring-1 ring-accent-success/50'
                      : 'border-dark-border bg-dark-hover text-gray-400 hover:border-gray-500'
                  }`}
                >
                  <span className="block text-lg mb-1">📅</span>
                  Citas
                </button>
              </div>
            </div>
          )}

          {selectedInstanceId && (status === 'open' || status === 'connected') && (
            <div className="card">
              <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                <span>📦</span> Catalogo
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Slug del catalogo</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs">/catalogo/</span>
                    <input
                      type="text"
                      value={instanceSlug}
                      onChange={(e) => {
                        const newSlug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
                        setInstanceSlug(newSlug);
                      }}
                      className="w-full text-xs bg-dark-bg border border-dark-border rounded px-2 py-1.5 pl-[70px] text-white focus:outline-none focus:border-neon-blue"
                      placeholder="mi-tienda"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Logo del catalogo (URL 500x500)</label>
                  <input
                    type="url"
                    value={instanceCatalogLogo}
                    onChange={(e) => setInstanceCatalogLogo(e.target.value)}
                    className="w-full text-xs bg-dark-bg border border-dark-border rounded px-2 py-1.5 text-white focus:outline-none focus:border-neon-blue"
                    placeholder="https://ejemplo.com/logo.png"
                  />
                  {instanceCatalogLogo && (
                    <div className="mt-2 flex justify-center">
                      <img 
                        src={instanceCatalogLogo} 
                        alt="Logo preview" 
                        className="w-16 h-16 rounded-lg object-cover border border-dark-border"
                        onError={(e) => (e.currentTarget.style.display = 'none')}
                      />
                    </div>
                  )}
                </div>
                <button
                  onClick={async () => {
                    if (currentBusiness && selectedInstanceId) {
                      setSavingCatalog(true);
                      try {
                        await waApi.updateInstance(selectedInstanceId, currentBusiness.id, { 
                          slug: instanceSlug || null, 
                          catalogLogoUrl: instanceCatalogLogo || null 
                        });
                        updateInstance(selectedInstanceId, { slug: instanceSlug, catalogLogoUrl: instanceCatalogLogo } as any);
                      } catch (err: any) {
                        setError(err.response?.data?.error || 'Error al guardar catalogo');
                      } finally {
                        setSavingCatalog(false);
                      }
                    }
                  }}
                  disabled={savingCatalog}
                  className="w-full text-xs px-3 py-2 bg-neon-blue/20 text-neon-blue rounded hover:bg-neon-blue/30 disabled:opacity-50 font-medium"
                >
                  {savingCatalog ? 'Guardando...' : 'Guardar catalogo'}
                </button>
                {instanceSlug && (
                  <div className="p-2 bg-dark-bg rounded-lg">
                    <p className="text-xs text-gray-400 mb-1">Tu catalogo:</p>
                    <a 
                      href={`/catalogo/${instanceSlug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-neon-blue hover:underline text-xs break-all"
                    >
                      {typeof window !== 'undefined' ? window.location.origin : ''}/catalogo/{instanceSlug}
                    </a>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="card">
            <h3 className="text-sm font-semibold text-gray-300 mb-2">💡 Ayuda</h3>
            <ul className="text-xs text-gray-400 space-y-1">
              <li><strong className="text-gray-300">Baileys:</strong> Conexion via QR (WhatsApp Web)</li>
              <li><strong className="text-gray-300">Meta Cloud:</strong> API oficial de WhatsApp Business</li>
              <li><strong className="text-gray-300">Coexistence:</strong> Conecta tu WhatsApp Business App via OAuth</li>
              <li>• <strong className="text-gray-300">QR no carga:</strong> Refrescar</li>
              <li>• <strong className="text-gray-300">QR expiro:</strong> Reiniciar</li>
            </ul>
          </div>

          {selectedInstanceId && (status === 'open' || status === 'connected') && isPro && (
            <div className="card">
              <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                <span>🔑</span> Credenciales API
              </h3>
              
              {apiConfigLoading ? (
                <div className="flex justify-center py-4">
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neon-blue"></div>
                </div>
              ) : apiConfig ? (
                <div className="space-y-3">
                  {newApiKey && (
                    <div className="bg-accent-success/10 border border-accent-success/30 rounded-lg p-3">
                      <p className="text-xs text-accent-success font-semibold mb-1">Nueva API Key (solo se muestra una vez):</p>
                      <div className="flex items-center gap-2">
                        <code className="text-xs bg-dark-bg px-2 py-1 rounded text-white flex-1 overflow-x-auto">{newApiKey}</code>
                        <button 
                          onClick={() => copyToClipboard(newApiKey, 'newApiKey')}
                          className="text-xs text-accent-success hover:text-accent-success/80"
                        >
                          {copiedField === 'newApiKey' ? '✓' : '📋'}
                        </button>
                      </div>
                    </div>
                  )}
                  
                  <div>
                    <label className="text-xs text-gray-400 block mb-1">API Key</label>
                    <div className="flex items-center gap-2">
                      <code className="text-xs bg-dark-bg px-2 py-1 rounded text-gray-300 flex-1">
                        {apiConfig.hasApiKey ? `${apiConfig.apiKeyPrefix}...` : 'No configurada'}
                      </code>
                      <button
                        onClick={handleRegenerateApiKey}
                        disabled={regeneratingKey}
                        className="text-xs px-2 py-1 bg-neon-blue/20 text-neon-blue rounded hover:bg-neon-blue/30 disabled:opacity-50"
                      >
                        {regeneratingKey ? '...' : 'Regenerar'}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-gray-400 block mb-1">Webhook URL</label>
                    {editingWebhook ? (
                      <div className="flex flex-col gap-2">
                        <input
                          type="url"
                          value={webhookUrlInput}
                          onChange={(e) => setWebhookUrlInput(e.target.value)}
                          placeholder="https://tu-servidor.com/webhook"
                          className="w-full text-xs bg-dark-bg border border-dark-border rounded px-2 py-1.5 text-white focus:outline-none focus:border-neon-blue"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleSaveWebhook(false)}
                            disabled={savingWebhook}
                            className="text-xs px-2 py-1 bg-accent-success/20 text-accent-success rounded hover:bg-accent-success/30 disabled:opacity-50"
                          >
                            {savingWebhook ? '...' : 'Guardar'}
                          </button>
                          <button
                            onClick={() => {
                              setEditingWebhook(false);
                              setWebhookUrlInput(apiConfig.webhookUrl || '');
                            }}
                            className="text-xs px-2 py-1 bg-gray-600/20 text-gray-400 rounded hover:bg-gray-600/30"
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <code className="text-xs bg-dark-bg px-2 py-1 rounded text-gray-300 flex-1 truncate">
                          {apiConfig.webhookUrl || 'No configurada'}
                        </code>
                        <button
                          onClick={() => setEditingWebhook(true)}
                          className="text-xs px-2 py-1 bg-neon-blue/20 text-neon-blue rounded hover:bg-neon-blue/30"
                        >
                          Editar
                        </button>
                      </div>
                    )}
                  </div>

                  {apiConfig.webhookSecret && (
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">Webhook Secret</label>
                      <div className="flex items-center gap-2">
                        <code className="text-xs bg-dark-bg px-2 py-1 rounded text-gray-300 flex-1 overflow-x-auto">
                          {apiConfig.webhookSecret}
                        </code>
                        <button 
                          onClick={() => copyToClipboard(apiConfig.webhookSecret!, 'webhookSecret')}
                          className="text-xs text-neon-blue hover:text-neon-blue/80"
                        >
                          {copiedField === 'webhookSecret' ? '✓' : '📋'}
                        </button>
                      </div>
                    </div>
                  )}

                  {apiConfig.webhookUrl && (
                    <div>
                      <button
                        onClick={() => {
                          setWebhookEventsInput(apiConfig.webhookEvents || []);
                          setShowAdvancedWebhook(true);
                        }}
                        className="text-xs text-neon-blue hover:text-cyan-400 flex items-center gap-1"
                      >
                        <span>⚙️</span> Opciones avanzadas
                        {(apiConfig.webhookEvents?.length || 0) > 0 && (
                          <span className="text-gray-500">({apiConfig.webhookEvents?.length || 0} eventos)</span>
                        )}
                      </button>
                    </div>
                  )}

                  {showAdvancedWebhook && typeof document !== 'undefined' && createPortal(
                    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[9999] p-2 sm:p-4">
                      <div className="bg-dark-card/95 backdrop-blur-sm border border-dark-border rounded-lg p-3 sm:p-4 w-full max-w-xs sm:max-w-sm shadow-2xl">
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="text-xs sm:text-sm font-semibold text-white">Eventos del Webhook</h3>
                          <button
                            onClick={() => setShowAdvancedWebhook(false)}
                            className="text-gray-400 hover:text-white text-lg leading-none"
                          >
                            ✕
                          </button>
                        </div>
                        
                        <p className="text-[10px] sm:text-xs text-gray-400 mb-2">
                          Selecciona los eventos a recibir. Sin selección = todos.
                        </p>
                        
                        <div className="space-y-0.5 mb-3">
                          {WEBHOOK_EVENTS.map(event => (
                            <label 
                              key={event.id}
                              className="flex items-center gap-2 py-1.5 px-1.5 rounded hover:bg-dark-hover cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={webhookEventsInput.includes(event.id)}
                                onChange={() => toggleWebhookEvent(event.id)}
                                className="w-3.5 h-3.5 rounded border-dark-border bg-dark-bg text-neon-blue focus:ring-neon-blue focus:ring-1"
                              />
                              <div className="flex-1 min-w-0">
                                <span className="text-xs sm:text-sm text-white block">{event.label}</span>
                                <span className="text-[10px] text-gray-500 block truncate">{event.desc}</span>
                              </div>
                            </label>
                          ))}
                        </div>
                        
                        <button
                          onClick={() => handleSaveWebhook(true)}
                          disabled={savingWebhook}
                          className="w-full text-xs px-2 py-1.5 bg-neon-blue text-dark-bg rounded font-medium hover:bg-cyan-400 disabled:opacity-50"
                        >
                          {savingWebhook ? '...' : 'Guardar'}
                        </button>
                      </div>
                    </div>,
                    document.body
                  )}

                  <div className="mt-3 pt-3 border-t border-dark-border">
                    <a
                      href="/dashboard/api-docs"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2 w-full text-xs px-3 py-2 bg-neon-blue/10 text-neon-blue rounded-lg hover:bg-neon-blue/20 transition-colors"
                    >
                      <span>📖</span> Ver Documentacion API
                    </a>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-gray-500 text-center py-2">No se pudo cargar la configuracion</p>
              )}
            </div>
          )}

          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
                <span>📜</span> Historial
              </h3>
              <button
                onClick={() => {
                  if (!showHistory) fetchHistory();
                  setShowHistory(!showHistory);
                }}
                className="text-xs text-neon-blue hover:text-cyan-400"
              >
                {showHistory ? 'Ocultar' : 'Ver historial'}
              </button>
            </div>
            
            {showHistory && (
              <>
                {historyLoading ? (
                  <div className="flex justify-center py-4">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neon-blue"></div>
                  </div>
                ) : historyEvents.length === 0 ? (
                  <p className="text-xs text-gray-500 text-center py-4">Sin historial de cambios</p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {historyEvents.map((event) => (
                      <div key={event.id} className="flex items-start gap-2 text-xs border-b border-dark-hover pb-2 last:border-0">
                        <span className={`${getHistoryEventColor(event.eventType)} flex-shrink-0 mt-0.5`}>
                          {getHistoryEventIcon(event.eventType)}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-gray-300 font-medium">{formatEventType(event.eventType)}</p>
                          {event.details && (
                            <p className="text-gray-500 truncate">{event.details}</p>
                          )}
                          {event.previousProvider && event.newProvider && (
                            <p className="text-gray-500">
                              {event.previousProvider} → {event.newProvider}
                            </p>
                          )}
                          <p className="text-gray-600">
                            {new Date(event.createdAt).toLocaleString()}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {showProviderModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-2xl w-full">
            <h2 className="text-xl font-bold text-white mb-4">Elige el tipo de conexion</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <button
                onClick={handleSelectBaileys}
                disabled={loading}
                className="p-4 border-2 border-dark-hover rounded-xl hover:border-accent-success hover:bg-accent-success/10 transition-all text-left group"
              >
                <div className="text-3xl mb-2">📲</div>
                <h3 className="font-semibold text-white group-hover:text-accent-success">Baileys</h3>
                <p className="text-xs text-gray-400 mt-1">Conexion via codigo QR. Usa la sesion de WhatsApp Web.</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  <span className="px-2 py-0.5 bg-accent-success/20 text-accent-success rounded text-xs">Gratis</span>
                  <span className="px-2 py-0.5 bg-dark-hover text-gray-400 rounded text-xs">Rapido</span>
                </div>
              </button>

              <button
                onClick={() => setShowMetaForm(true)}
                disabled={loading}
                className="p-4 border-2 border-dark-hover rounded-xl hover:border-neon-blue hover:bg-neon-blue/10 transition-all text-left group"
              >
                <div className="text-3xl mb-2">📱</div>
                <h3 className="font-semibold text-white group-hover:text-neon-blue">Meta Cloud API</h3>
                <p className="text-xs text-gray-400 mt-1">API oficial de WhatsApp Business. Requiere cuenta de Meta.</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  <span className="px-2 py-0.5 bg-neon-blue/20 text-neon-blue rounded text-xs">Oficial</span>
                  <span className="px-2 py-0.5 bg-dark-hover text-gray-400 rounded text-xs">Templates</span>
                </div>
              </button>

              <button
                onClick={handleStartCoexistence}
                disabled={loading}
                className="p-4 border-2 border-dark-hover rounded-xl hover:border-purple-500 hover:bg-purple-500/10 transition-all text-left group"
              >
                <div className="text-3xl mb-2">🔗</div>
                <h3 className="font-semibold text-white group-hover:text-purple-400">Coexistence</h3>
                <p className="text-xs text-gray-400 mt-1">Conecta tu WhatsApp Business App existente via Facebook.</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  <span className="px-2 py-0.5 bg-purple-500/20 text-purple-400 rounded text-xs">Facil</span>
                  <span className="px-2 py-0.5 bg-dark-hover text-gray-400 rounded text-xs">OAuth</span>
                </div>
              </button>
            </div>

            <button
              onClick={() => setShowProviderModal(false)}
              className="w-full btn btn-secondary"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {showPhoneInput && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-md w-full">
            <h2 className="text-xl font-bold text-white mb-2">Ingresa tu numero de WhatsApp</h2>
            <p className="text-gray-400 text-sm mb-4">Este numero se guardara para identificar tu instancia.</p>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Codigo de pais</label>
                <select
                  value={countryCode}
                  onChange={e => setCountryCode(e.target.value)}
                  className="input w-full"
                >
                  {COUNTRY_CODES.map(cc => (
                    <option key={cc.code} value={cc.code}>
                      {cc.flag} {cc.code} - {cc.country}
                    </option>
                  ))}
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Numero de telefono</label>
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 font-medium">{countryCode}</span>
                  <input
                    type="tel"
                    value={phoneInput}
                    onChange={e => setPhoneInput(e.target.value.replace(/\D/g, ''))}
                    className="input flex-1"
                    placeholder="1234567890"
                    maxLength={15}
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">Solo numeros, sin espacios ni guiones</p>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowPhoneInput(false);
                  setPhoneInput('');
                  setShowProviderModal(true);
                }}
                className="flex-1 btn btn-secondary"
              >
                Volver
              </button>
              <button
                onClick={handleCreateBaileys}
                disabled={loading || !phoneInput}
                className="flex-1 btn btn-primary"
              >
                {loading ? 'Creando...' : 'Continuar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showMetaForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-white mb-4">Configurar Meta Cloud API</h2>
            
            <div className="bg-neon-blue/10 border border-neon-blue/30 text-neon-blue px-3 py-2 rounded-lg mb-4 text-xs">
              Necesitas una cuenta de Meta Business Suite y una app de WhatsApp configurada.
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Nombre (opcional)</label>
                <input
                  type="text"
                  value={metaForm.name}
                  onChange={e => setMetaForm(prev => ({ ...prev, name: e.target.value }))}
                  className="input"
                  placeholder="Mi WhatsApp Business"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Access Token *</label>
                <input
                  type="password"
                  value={metaForm.accessToken}
                  onChange={e => setMetaForm(prev => ({ ...prev, accessToken: e.target.value }))}
                  className="input"
                  placeholder="EAAGm..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Meta Business ID *</label>
                <input
                  type="text"
                  value={metaForm.metaBusinessId}
                  onChange={e => setMetaForm(prev => ({ ...prev, metaBusinessId: e.target.value }))}
                  className="input"
                  placeholder="123456789..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Phone Number ID *</label>
                <input
                  type="text"
                  value={metaForm.phoneNumberId}
                  onChange={e => setMetaForm(prev => ({ ...prev, phoneNumberId: e.target.value }))}
                  className="input"
                  placeholder="123456789..."
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">App ID *</label>
                  <input
                    type="text"
                    value={metaForm.appId}
                    onChange={e => setMetaForm(prev => ({ ...prev, appId: e.target.value }))}
                    className="input"
                    placeholder="123456..."
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">App Secret *</label>
                  <input
                    type="password"
                    value={metaForm.appSecret}
                    onChange={e => setMetaForm(prev => ({ ...prev, appSecret: e.target.value }))}
                    className="input"
                    placeholder="abc123..."
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Numero de telefono de WhatsApp *</label>
                <input
                  type="tel"
                  value={metaForm.displayPhoneNumber}
                  onChange={e => setMetaForm(prev => ({ ...prev, displayPhoneNumber: e.target.value.replace(/\D/g, '') }))}
                  className="input"
                  placeholder="521234567890 (incluye codigo de pais)"
                />
                <p className="text-xs text-gray-500 mt-1">Incluye el codigo de pais, ejemplo: 521234567890 para Mexico</p>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowMetaForm(false);
                  setMetaForm({
                    name: '',
                    accessToken: '',
                    metaBusinessId: '',
                    phoneNumberId: '',
                    appId: '',
                    appSecret: '',
                    displayPhoneNumber: ''
                  });
                }}
                className="flex-1 btn btn-secondary"
              >
                Cancelar
              </button>
              <button
                onClick={handleCreateMeta}
                disabled={loading}
                className="flex-1 btn btn-primary"
              >
                {loading ? 'Conectando...' : 'Conectar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showReconnectModal && currentBusiness && selectedInstanceId && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-lg w-full">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-white">Reconectar WhatsApp</h2>
              <button 
                onClick={() => setShowReconnectModal(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <p className="text-sm text-gray-400 mb-4">
              Se abrira el flujo de autorizacion de Facebook. Autoriza la misma cuenta de WhatsApp Business para renovar la conexion.
            </p>
            
            <MetaEmbeddedSignup
              businessId={currentBusiness.id}
              provider="META_COEXIST"
              instanceId={selectedInstanceId}
              isReconnect={true}
              onSuccess={(instance) => {
                setShowReconnectModal(false);
                addEvent('success', `Reconexion exitosa: ${instance.phoneNumber || instance.name}`);
                fetchStatus();
              }}
              onError={(error) => {
                setError(error);
                addEvent('error', `Error al reconectar: ${error}`);
              }}
              onCancel={() => setShowReconnectModal(false)}
            />
          </div>
        </div>
      )}
      </>)}
    </div>
  );
}

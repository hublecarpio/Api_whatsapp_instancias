'use client';

import { useState, useEffect } from 'react';
import { useBusinessStore } from '@/store/business';
import { useInstanceStore } from '@/store/instance';
import { remindersApi, templatesApi, waApi } from '@/lib/api';
import CustomSelect from '@/components/ui/CustomSelect';

interface FollowUpStep {
  delayMinutes: number;
  pressureLevel: number;
}

interface TemplateVariable {
  position: number;
  fieldMapping: string;
}

interface MetaTemplate {
  id: string;
  name: string;
  status: string;
  bodyText: string | null;
  components: any[];
}

interface FollowUpConfig {
  id: string;
  enabled: boolean;
  firstDelayMinutes: number;
  secondDelayMinutes: number;
  thirdDelayMinutes: number;
  maxDailyAttempts: number;
  pressureLevel: number;
  allowedStartHour: number;
  allowedEndHour: number;
  weekendsEnabled: boolean;
  triggerMode: 'user' | 'agent' | 'any';
  stopOnReply: boolean;
  followUpSteps: FollowUpStep[] | null;
  metaTemplateId: string | null;
  templateVariables: TemplateVariable[] | null;
  templateEnabled: boolean;
}

interface Reminder {
  id: string;
  contactPhone: string;
  contactName?: string;
  scheduledAt: string;
  executedAt?: string;
  type: string;
  status: string;
  attemptNumber: number;
  retryCount: number;
  lastError?: string;
  messageTemplate?: string;
  generatedMessage?: string;
  instanceId?: string | null;
}

const CONTACT_FIELDS = [
  { value: 'name', label: 'Nombre del contacto' },
  { value: 'phone', label: 'Telefono' },
  { value: 'email', label: 'Email' },
  { value: 'businessName', label: 'Nombre del negocio' },
  { value: 'tags', label: 'Etiquetas (primera)' },
  { value: 'leadStage', label: 'Etapa del lead' },
  { value: 'pendingOrderTotal', label: 'Total pedido pendiente' }
];

const PRESSURE_LEVELS = [
  { value: 1, label: 'Muy sutil', description: 'Recordatorio casual y amigable' },
  { value: 2, label: 'Amigable', description: 'Muestra interes genuino' },
  { value: 3, label: 'Directo', description: 'Profesional y al punto' },
  { value: 4, label: 'Urgente', description: 'Con sentido de urgencia' },
  { value: 5, label: 'Agresivo', description: 'Enfatiza escasez' }
];

function extractTemplateVariables(bodyText: string | null): number[] {
  if (!bodyText) return [];
  const matches = bodyText.match(/\{\{(\d+)\}\}/g) || [];
  return matches.map(m => parseInt(m.replace(/[{}]/g, '')));
}

function formatTimeRemaining(scheduledAt: string): string {
  const now = new Date();
  const scheduled = new Date(scheduledAt);
  const diffMs = scheduled.getTime() - now.getTime();
  
  if (diffMs < 0) return 'Listo para enviar';
  
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffDays > 0) return `En ${diffDays}d ${diffHours % 24}h`;
  if (diffHours > 0) return `En ${diffHours}h ${diffMins % 60}m`;
  return `En ${diffMins}m`;
}

export default function RemindersPage() {
  const { currentBusiness } = useBusinessStore();
  const { instances, setInstances, selectedInstanceId, setSelectedInstanceId } = useInstanceStore();
  const [config, setConfig] = useState<FollowUpConfig | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [templates, setTemplates] = useState<MetaTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'config' | 'template' | 'pending' | 'history' | 'logs'>('config');
  const [syncingTemplates, setSyncingTemplates] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [expandedReminder, setExpandedReminder] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [filterInstanceId, setFilterInstanceId] = useState<string>('');

  useEffect(() => {
    if (currentBusiness) {
      fetchData();
      waApi.listInstances(currentBusiness.id).then(res => {
        if (res.data && Array.isArray(res.data.instances)) {
          setInstances(res.data.instances);
        }
      }).catch(() => {});
    }
  }, [currentBusiness]);

  useEffect(() => {
    if (currentBusiness) {
      fetchData();
    }
  }, [selectedInstanceId]);

  useEffect(() => {
    if (!currentBusiness || !['pending', 'history', 'logs'].includes(activeTab)) return;
    
    const refreshReminders = async () => {
      try {
        const res = await remindersApi.list(currentBusiness.id);
        setReminders(res.data);
        setLastRefresh(new Date());
      } catch (err) {
        console.error('Error refreshing reminders:', err);
      }
    };
    
    refreshReminders();
    const interval = setInterval(refreshReminders, 5000);
    return () => clearInterval(interval);
  }, [currentBusiness, activeTab]);

  const handleManualRefresh = async () => {
    if (!currentBusiness || refreshing) return;
    setRefreshing(true);
    try {
      const res = await remindersApi.list(currentBusiness.id);
      setReminders(res.data);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Error refreshing reminders:', err);
    } finally {
      setRefreshing(false);
    }
  };

  const fetchData = async (instId?: string) => {
    if (!currentBusiness) return;
    setLoading(true);
    try {
      const [configRes, remindersRes] = await Promise.all([
        remindersApi.getConfig(currentBusiness.id, instId || selectedInstanceId || undefined),
        remindersApi.list(currentBusiness.id)
      ]);
      
      const rawConfig = configRes.data;
      let steps: FollowUpStep[] | null = rawConfig.followUpSteps;
      
      if (!steps || steps.length === 0) {
        steps = [
          { delayMinutes: rawConfig.firstDelayMinutes || 15, pressureLevel: 1 },
          { delayMinutes: rawConfig.secondDelayMinutes || 60, pressureLevel: 2 },
          { delayMinutes: rawConfig.thirdDelayMinutes || 240, pressureLevel: 3 }
        ];
      }
      
      setConfig({
        ...rawConfig,
        triggerMode: rawConfig.triggerMode || 'user',
        stopOnReply: rawConfig.stopOnReply !== false,
        followUpSteps: steps,
        metaTemplateId: rawConfig.metaTemplateId || null,
        templateVariables: rawConfig.templateVariables || null,
        templateEnabled: rawConfig.templateEnabled || false
      });
      setReminders(remindersRes.data);
      
      try {
        const templatesRes = await templatesApi.list(currentBusiness.id);
        setTemplates(templatesRes.data.filter((t: MetaTemplate) => t.status === 'APPROVED'));
      } catch {
        setTemplates([]);
      }
    } catch (err) {
      console.error('Error loading data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSyncTemplates = async () => {
    if (!currentBusiness) return;
    setSyncingTemplates(true);
    try {
      await templatesApi.sync(currentBusiness.id);
      const templatesRes = await templatesApi.list(currentBusiness.id);
      setTemplates(templatesRes.data.filter((t: MetaTemplate) => t.status === 'APPROVED'));
    } catch (err) {
      console.error('Error syncing templates:', err);
    } finally {
      setSyncingTemplates(false);
    }
  };

  const handleSaveConfig = async () => {
    if (!currentBusiness || !config) return;
    setSaving(true);
    try {
      const configData = selectedInstanceId ? { ...config, instanceId: selectedInstanceId } : config;
      await remindersApi.updateConfig(currentBusiness.id, configData);
    } catch (err) {
      console.error('Error saving config:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleConfigInstanceChange = async (instId: string) => {
    setSelectedInstanceId(instId || null);
    await fetchData(instId);
  };

  const handleCancelReminder = async (id: string) => {
    try {
      await remindersApi.cancel(id);
      fetchData();
    } catch (err) {
      console.error('Error cancelling reminder:', err);
    }
  };

  const handleRetryReminder = async (id: string) => {
    if (!currentBusiness) return;
    setRetrying(id);
    try {
      await remindersApi.retry(id);
      await handleManualRefresh();
    } catch (err) {
      console.error('Error retrying reminder:', err);
    } finally {
      setRetrying(null);
    }
  };

  const handleTemplateChange = (templateId: string) => {
    if (!config) return;
    
    const template = templates.find(t => t.id === templateId);
    const variables = template ? extractTemplateVariables(template.bodyText) : [];
    
    const newVariables: TemplateVariable[] = variables.map(pos => ({
      position: pos,
      fieldMapping: 'name'
    }));
    
    setConfig({
      ...config,
      metaTemplateId: templateId || null,
      templateVariables: newVariables.length > 0 ? newVariables : null
    });
  };

  const handleVariableMapping = (position: number, fieldMapping: string) => {
    if (!config) return;
    
    const currentVars = config.templateVariables || [];
    const updatedVars = currentVars.map(v => 
      v.position === position ? { ...v, fieldMapping } : v
    );
    
    setConfig({
      ...config,
      templateVariables: updatedVars
    });
  };

  const addStep = () => {
    if (!config) return;
    const steps = config.followUpSteps || [];
    const lastDelay = steps.length > 0 ? steps[steps.length - 1].delayMinutes : 0;
    setConfig({
      ...config,
      followUpSteps: [...steps, { delayMinutes: lastDelay + 60, pressureLevel: Math.min(steps.length + 1, 5) }]
    });
  };

  const removeStep = (index: number) => {
    if (!config || !config.followUpSteps) return;
    if (config.followUpSteps.length <= 1) return;
    setConfig({
      ...config,
      followUpSteps: config.followUpSteps.filter((_, i) => i !== index)
    });
  };

  const updateStep = (index: number, field: keyof FollowUpStep, value: number) => {
    if (!config || !config.followUpSteps) return;
    const newSteps = [...config.followUpSteps];
    newSteps[index] = { ...newSteps[index], [field]: value };
    setConfig({ ...config, followUpSteps: newSteps });
  };

  const selectedTemplate = templates.find(t => t.id === config?.metaTemplateId);
  const templateVariables = selectedTemplate ? extractTemplateVariables(selectedTemplate.bodyText) : [];

  const formatDate = (date: string) => {
    return new Date(date).toLocaleString('es-MX', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getStatusBadge = (status: string, retryCount?: number) => {
    const colors: Record<string, string> = {
      pending: 'bg-accent-warning/20 text-accent-warning',
      executed: 'bg-accent-success/20 text-accent-success',
      cancelled: 'bg-dark-hover text-gray-400',
      failed: 'bg-accent-error/20 text-accent-error',
      skipped: 'bg-neon-blue/20 text-neon-blue',
      max_daily_reached: 'bg-accent-warning/20 text-accent-warning',
      no_template: 'bg-neon-purple/20 text-neon-purple',
      template_error: 'bg-accent-error/20 text-accent-error'
    };
    const labels: Record<string, string> = {
      pending: 'Pendiente',
      executed: 'Enviado',
      cancelled: 'Cancelado',
      failed: 'Fallido',
      skipped: 'Omitido',
      max_daily_reached: 'Limite diario',
      no_template: 'Sin plantilla',
      template_error: 'Error plantilla'
    };
    return (
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[status] || 'bg-dark-hover text-gray-400'}`}>
        {labels[status] || status}
        {retryCount && retryCount > 0 && status === 'pending' && ` (reintento ${retryCount})`}
      </span>
    );
  };

  const pendingReminders = reminders.filter(r => r.status === 'pending');
  const historyReminders = reminders.filter(r => r.status !== 'pending' && r.status !== 'failed' && r.status !== 'template_error' && r.status !== 'no_template');
  const errorReminders = reminders.filter(r => ['failed', 'template_error', 'no_template', 'max_daily_reached'].includes(r.status));

  const filteredHistory = statusFilter === 'all' 
    ? historyReminders 
    : historyReminders.filter(r => r.status === statusFilter);

  const errorStats = {
    total: errorReminders.length,
    failed: errorReminders.filter(r => r.status === 'failed').length,
    noTemplate: errorReminders.filter(r => r.status === 'no_template').length,
    templateError: errorReminders.filter(r => r.status === 'template_error').length,
    maxDaily: errorReminders.filter(r => r.status === 'max_daily_reached').length
  };

  if (!currentBusiness) {
    return (
      <div className="p-6 text-center text-gray-400">
        Primero selecciona una empresa.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6 flex justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-neon-blue"></div>
      </div>
    );
  }

  const selectedInstance = instances.find((i: any) => i.id === selectedInstanceId);

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white">Seguimiento Automatico</h1>
          <p className="text-gray-400 text-sm mt-1">
            Configura el seguimiento automatico para clientes que no responden
          </p>
        </div>
        {instances.length > 1 && (
          <div className="flex items-center gap-3">
            {selectedInstance && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-dark-card border border-dark-border rounded-lg">
                <div className={`w-2 h-2 rounded-full ${selectedInstance.status === 'CONNECTED' ? 'bg-accent-success' : 'bg-gray-500'}`} />
                <span className="text-xs text-gray-400">Instancia:</span>
                <span className="text-sm text-white font-medium">
                  {selectedInstance.phoneNumber || selectedInstance.name || 'Instancia'}
                </span>
              </div>
            )}
            <CustomSelect
              value={selectedInstanceId || instances[0]?.id || ''}
              onChange={(val) => handleConfigInstanceChange(val)}
              options={instances.map((inst: any) => ({
                  value: inst.id,
                  label: `${inst.name} ${inst.phoneNumber ? `(${inst.phoneNumber})` : ''}`
                }))}
              className="min-w-[180px]"
            />
          </div>
        )}
      </div>

      <div className="flex gap-2 mb-6 overflow-x-auto hide-scrollbar">
        {(['config', 'template', 'pending', 'history', 'logs'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-lg transition-colors whitespace-nowrap flex items-center gap-2 ${
              activeTab === tab 
                ? 'bg-neon-blue text-dark-bg' 
                : 'bg-dark-card text-gray-400 hover:bg-dark-hover'
            }`}
          >
            {tab === 'config' && 'Configuracion'}
            {tab === 'template' && 'Plantilla Meta'}
            {tab === 'pending' && (
              <>
                Pendientes
                {pendingReminders.length > 0 && (
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${activeTab === tab ? 'bg-dark-bg text-neon-blue' : 'bg-accent-warning/20 text-accent-warning'}`}>
                    {pendingReminders.length}
                  </span>
                )}
              </>
            )}
            {tab === 'history' && 'Historial'}
            {tab === 'logs' && (
              <>
                Errores
                {errorReminders.length > 0 && (
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${activeTab === tab ? 'bg-dark-bg text-neon-blue' : 'bg-accent-error/20 text-accent-error'}`}>
                    {errorReminders.length}
                  </span>
                )}
              </>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'config' && config && (
        <div className="card">

          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="font-semibold text-lg text-white">Seguimiento automatico</h3>
              <p className="text-sm text-gray-400">El sistema enviara mensajes cuando el cliente no responda</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-dark-hover rounded-full peer peer-checked:bg-neon-blue peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
            </label>
          </div>

          <div className="mb-6 p-4 bg-dark-bg rounded-lg border border-dark-border">
            <h4 className="text-sm font-medium text-white mb-3">Modo de activacion</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => setConfig({ ...config, triggerMode: 'user' })}
                className={`p-3 rounded-lg border text-sm text-left transition-all ${
                  config.triggerMode === 'user' 
                    ? 'border-neon-blue bg-neon-blue/10 text-white' 
                    : 'border-dark-border bg-dark-card text-gray-400 hover:border-gray-600'
                }`}
              >
                <div className="font-medium mb-1">Tu le escribes</div>
                <div className="text-xs text-gray-500">Seguimiento cuando TU le escribes al cliente</div>
              </button>
              <button
                type="button"
                onClick={() => setConfig({ ...config, triggerMode: 'agent' })}
                className={`p-3 rounded-lg border text-sm text-left transition-all ${
                  config.triggerMode === 'agent' 
                    ? 'border-neon-purple bg-neon-purple/10 text-white' 
                    : 'border-dark-border bg-dark-card text-gray-400 hover:border-gray-600'
                }`}
              >
                <div className="font-medium mb-1">El agente IA escribe</div>
                <div className="text-xs text-gray-500">Seguimiento cuando el AGENTE IA escribe</div>
              </button>
              <button
                type="button"
                onClick={() => setConfig({ ...config, triggerMode: 'any' })}
                className={`p-3 rounded-lg border text-sm text-left transition-all ${
                  config.triggerMode === 'any' 
                    ? 'border-accent-success bg-accent-success/10 text-white' 
                    : 'border-dark-border bg-dark-card text-gray-400 hover:border-gray-600'
                }`}
              >
                <div className="font-medium mb-1">Ambos casos</div>
                <div className="text-xs text-gray-500">Cualquier mensaje sin respuesta</div>
              </button>
            </div>
            
            <div className="mt-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.stopOnReply}
                  onChange={(e) => setConfig({ ...config, stopOnReply: e.target.checked })}
                  className="w-4 h-4 text-neon-blue bg-dark-card border-dark-border rounded focus:ring-neon-blue"
                />
                <span className="text-sm text-gray-300">Cancelar seguimiento si el cliente responde</span>
              </label>
            </div>
          </div>

          <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h4 className="text-sm font-medium text-white">Pasos de seguimiento</h4>
                <p className="text-xs text-gray-500 mt-1">Define cuantos recordatorios enviar y cuando</p>
              </div>
              <button
                onClick={addStep}
                className="text-sm text-neon-blue hover:text-neon-blue/80 flex items-center gap-1"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Agregar paso
              </button>
            </div>

            <div className="space-y-3">
              {config.followUpSteps?.map((step, index) => (
                <div key={index} className="p-4 bg-dark-bg rounded-lg border border-dark-border">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 bg-neon-blue/20 text-neon-blue rounded-full flex items-center justify-center text-xs font-bold">
                        {index + 1}
                      </span>
                      <span className="text-sm font-medium text-white">
                        {index === 0 ? 'Primer recordatorio' : `Recordatorio ${index + 1}`}
                      </span>
                    </div>
                    {(config.followUpSteps?.length || 0) > 1 && (
                      <button
                        onClick={() => removeStep(index)}
                        className="text-gray-500 hover:text-accent-error transition-colors"
                        title="Eliminar paso"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">
                        {index === 0 ? 'Minutos despues del ultimo mensaje' : 'Minutos despues del paso anterior'}
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          value={step.delayMinutes}
                          onChange={(e) => updateStep(index, 'delayMinutes', parseInt(e.target.value) || 15)}
                          className="input flex-1"
                          min={1}
                        />
                        <span className="text-xs text-gray-500 w-20">
                          {step.delayMinutes >= 60 
                            ? `${Math.floor(step.delayMinutes / 60)}h ${step.delayMinutes % 60}m` 
                            : `${step.delayMinutes}m`}
                        </span>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Nivel de presion</label>
                      <select
                        value={step.pressureLevel}
                        onChange={(e) => updateStep(index, 'pressureLevel', parseInt(e.target.value))}
                        className="input w-full"
                      >
                        {PRESSURE_LEVELS.map(level => (
                          <option key={level.value} value={level.value}>
                            {level.value} - {level.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Maximo intentos por dia
              </label>
              <input
                type="number"
                value={config.maxDailyAttempts}
                onChange={(e) => setConfig({ ...config, maxDailyAttempts: parseInt(e.target.value) || 3 })}
                className="input"
                min={1}
                max={20}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Horario permitido
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={config.allowedStartHour}
                  onChange={(e) => setConfig({ ...config, allowedStartHour: parseInt(e.target.value) || 9 })}
                  className="input w-20"
                  min={0}
                  max={23}
                />
                <span className="text-gray-400">a</span>
                <input
                  type="number"
                  value={config.allowedEndHour}
                  onChange={(e) => setConfig({ ...config, allowedEndHour: parseInt(e.target.value) || 21 })}
                  className="input w-20"
                  min={0}
                  max={23}
                />
                <span className="text-gray-400">hrs</span>
              </div>
            </div>
          </div>

          <div className="mt-6 flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.weekendsEnabled}
                onChange={(e) => setConfig({ ...config, weekendsEnabled: e.target.checked })}
                className="w-4 h-4 text-neon-blue bg-dark-card border-dark-border rounded focus:ring-neon-blue"
              />
              <span className="text-sm text-gray-300">Enviar en fines de semana</span>
            </label>
          </div>

          <div className="mt-8 flex justify-end">
            <button
              onClick={handleSaveConfig}
              disabled={saving}
              className="btn btn-primary"
            >
              {saving ? 'Guardando...' : 'Guardar configuracion'}
            </button>
          </div>
        </div>
      )}

      {activeTab === 'template' && config && (
        <div className="card">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="font-semibold text-lg text-white">Plantilla de Meta Cloud</h3>
              <p className="text-sm text-gray-400">Template de WhatsApp para seguimientos (fuera de ventana 24h)</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={config.templateEnabled}
                onChange={(e) => setConfig({ ...config, templateEnabled: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-dark-hover rounded-full peer peer-checked:bg-accent-success peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
            </label>
          </div>

          {!config.templateEnabled && (
            <div className="mb-6 p-4 bg-accent-warning/10 rounded-lg border border-accent-warning/30">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-accent-warning flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div>
                  <p className="text-sm text-accent-warning font-medium">Template deshabilitado</p>
                  <p className="text-xs text-gray-400 mt-1">Los recordatorios Meta Cloud se marcaran como "Sin plantilla"</p>
                </div>
              </div>
            </div>
          )}

          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <label className="block text-sm font-medium text-gray-300">
                Seleccionar plantilla aprobada
              </label>
              <button
                onClick={handleSyncTemplates}
                disabled={syncingTemplates}
                className="text-xs text-neon-blue hover:underline flex items-center gap-1"
              >
                <svg className={`w-3 h-3 ${syncingTemplates ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {syncingTemplates ? 'Sincronizando...' : 'Sincronizar desde Meta'}
              </button>
            </div>
            
            {templates.length === 0 ? (
              <div className="p-6 bg-dark-bg rounded-lg border border-dark-border text-center">
                <svg className="w-12 h-12 text-gray-600 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p className="text-gray-400 text-sm">No hay plantillas aprobadas</p>
              </div>
            ) : (
              <select
                value={config.metaTemplateId || ''}
                onChange={(e) => handleTemplateChange(e.target.value)}
                className="input"
              >
                <option value="">Seleccionar plantilla...</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            )}
          </div>

          {selectedTemplate && (
            <>
              <div className="mb-6 p-4 bg-dark-bg rounded-lg border border-dark-border">
                <h4 className="text-sm font-medium text-white mb-2">Vista previa</h4>
                <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedTemplate.bodyText}</p>
              </div>

              {templateVariables.length > 0 && (
                <div className="mb-6">
                  <h4 className="text-sm font-medium text-white mb-3">Mapeo de variables</h4>
                  <div className="space-y-3">
                    {templateVariables.map(pos => {
                      const currentMapping = config.templateVariables?.find(v => v.position === pos);
                      return (
                        <div key={pos} className="flex items-center gap-4 p-3 bg-dark-bg rounded-lg border border-dark-border">
                          <span className="text-neon-blue font-mono text-sm w-12">{`{{${pos}}}`}</span>
                          <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                          </svg>
                          <select
                            value={currentMapping?.fieldMapping || 'name'}
                            onChange={(e) => handleVariableMapping(pos, e.target.value)}
                            className="input flex-1"
                          >
                            {CONTACT_FIELDS.map(field => (
                              <option key={field.value} value={field.value}>{field.label}</option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          <div className="mt-8 flex justify-end">
            <button
              onClick={handleSaveConfig}
              disabled={saving}
              className="btn btn-primary"
            >
              {saving ? 'Guardando...' : 'Guardar configuracion'}
            </button>
          </div>
        </div>
      )}

      {activeTab === 'pending' && (
        <div className="card overflow-hidden p-0">
          <div className="p-4 border-b border-dark-border flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-white">Cola de recordatorios ({pendingReminders.filter(r => !filterInstanceId || r.instanceId === filterInstanceId).length})</h3>
              {lastRefresh && (
                <p className="text-xs text-gray-500 mt-1">
                  Actualizado: {lastRefresh.toLocaleTimeString()}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {instances.length > 1 && (
                <select
                  value={filterInstanceId}
                  onChange={(e) => setFilterInstanceId(e.target.value)}
                  className="text-xs bg-dark-bg border border-dark-border rounded-lg px-2 py-1.5 text-gray-300"
                >
                  <option value="">Todas las instancias</option>
                  {instances.map(inst => (
                    <option key={inst.id} value={inst.id}>
                      {inst.name || inst.phoneNumber || inst.id.slice(0,8)}
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={handleManualRefresh}
                disabled={refreshing}
                className="p-2 hover:bg-dark-hover rounded-lg transition-colors"
                title="Actualizar"
              >
                <svg className={`w-5 h-5 text-gray-400 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>
          </div>
          
          {pendingReminders.filter(r => !filterInstanceId || r.instanceId === filterInstanceId).length === 0 ? (
            <div className="p-8 text-center">
              <svg className="w-12 h-12 text-gray-600 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-gray-400">No hay recordatorios pendientes</p>
              <p className="text-xs text-gray-500 mt-1">Los recordatorios aparecen cuando un cliente no responde</p>
            </div>
          ) : (
            <div className="divide-y divide-dark-border">
              {pendingReminders.filter(r => !filterInstanceId || r.instanceId === filterInstanceId).map(reminder => (
                <div key={reminder.id} className="p-4 hover:bg-dark-hover/50 transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className="w-10 h-10 bg-accent-warning/20 rounded-full flex items-center justify-center flex-shrink-0">
                        <span className="text-accent-warning font-bold text-sm">#{reminder.attemptNumber}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium text-white truncate">
                            {reminder.contactName || reminder.contactPhone}
                          </p>
                          <span className={`text-xs px-2 py-0.5 rounded ${
                            reminder.type === 'manual' ? 'bg-neon-blue/20 text-neon-blue' : 'bg-dark-hover text-gray-400'
                          }`}>
                            {reminder.type === 'manual' ? 'Manual' : 'Auto'}
                          </span>
                          {reminder.instanceId && instances.length > 1 && (() => {
                            const inst = instances.find(i => i.id === reminder.instanceId);
                            return inst ? (
                              <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                                {inst.name || inst.phoneNumber || inst.id.slice(0,6)}
                              </span>
                            ) : null;
                          })()}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-sm">
                          <span className="text-accent-warning font-medium">
                            {formatTimeRemaining(reminder.scheduledAt)}
                          </span>
                          <span className="text-gray-500">
                            {formatDate(reminder.scheduledAt)}
                          </span>
                        </div>
                        {reminder.messageTemplate && (
                          <p className="text-xs text-gray-500 mt-2 line-clamp-2">
                            {reminder.messageTemplate}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => handleCancelReminder(reminder.id)}
                        className="px-3 py-1.5 text-sm text-accent-error hover:bg-accent-error/10 rounded-lg transition-colors"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'history' && (
        <div className="card overflow-hidden p-0">
          <div className="p-4 border-b border-dark-border">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-white">Historial de envios</h3>
              <div className="flex items-center gap-2">
                {instances.length > 1 && (
                  <select
                    value={filterInstanceId}
                    onChange={(e) => setFilterInstanceId(e.target.value)}
                    className="text-xs bg-dark-bg border border-dark-border rounded-lg px-2 py-1.5 text-gray-300"
                  >
                    <option value="">Todas las instancias</option>
                    {instances.map(inst => (
                      <option key={inst.id} value={inst.id}>
                        {inst.name || inst.phoneNumber || inst.id.slice(0,8)}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  onClick={handleManualRefresh}
                  disabled={refreshing}
                  className="p-2 hover:bg-dark-hover rounded-lg transition-colors"
                >
                  <svg className={`w-5 h-5 text-gray-400 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="flex gap-2 overflow-x-auto hide-scrollbar">
              {[
                { value: 'all', label: 'Todos' },
                { value: 'executed', label: 'Enviados' },
                { value: 'cancelled', label: 'Cancelados' },
                { value: 'skipped', label: 'Omitidos' }
              ].map(filter => (
                <button
                  key={filter.value}
                  onClick={() => setStatusFilter(filter.value)}
                  className={`px-3 py-1 text-xs rounded-full transition-colors ${
                    statusFilter === filter.value
                      ? 'bg-neon-blue text-dark-bg'
                      : 'bg-dark-hover text-gray-400 hover:text-white'
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>
          
          {filteredHistory.filter(r => !filterInstanceId || r.instanceId === filterInstanceId).length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No hay historial de seguimientos
            </div>
          ) : (
            <div className="divide-y divide-dark-border">
              {filteredHistory.filter(r => !filterInstanceId || r.instanceId === filterInstanceId).slice(0, 50).map(reminder => (
                <div 
                  key={reminder.id} 
                  className="hover:bg-dark-hover/50 transition-colors cursor-pointer"
                  onClick={() => setExpandedReminder(expandedReminder === reminder.id ? null : reminder.id)}
                >
                  <div className="p-4 flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-white truncate">
                          {reminder.contactName || reminder.contactPhone}
                        </p>
                        <span className="text-xs text-gray-500">#{reminder.attemptNumber}</span>
                        {reminder.instanceId && instances.length > 1 && (() => {
                          const inst = instances.find(i => i.id === reminder.instanceId);
                          return inst ? (
                            <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                              {inst.name || inst.phoneNumber || inst.id.slice(0,6)}
                            </span>
                          ) : null;
                        })()}
                      </div>
                      <p className="text-sm text-gray-400">
                        {formatDate(reminder.executedAt || reminder.scheduledAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {getStatusBadge(reminder.status)}
                      <svg 
                        className={`w-4 h-4 text-gray-500 transition-transform ${expandedReminder === reminder.id ? 'rotate-180' : ''}`} 
                        fill="none" 
                        stroke="currentColor" 
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </div>
                  
                  {expandedReminder === reminder.id && (
                    <div className="px-4 pb-4 border-t border-dark-border/50 mt-0 pt-3">
                      <div className="bg-dark-bg rounded-lg p-3 text-sm">
                        <p className="text-gray-400 mb-1">Mensaje enviado:</p>
                        <p className="text-white whitespace-pre-wrap">
                          {reminder.generatedMessage || reminder.messageTemplate || 'Sin mensaje registrado'}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'logs' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
              <p className="text-2xl font-bold text-accent-error">{errorStats.failed}</p>
              <p className="text-xs text-gray-400">Fallidos</p>
            </div>
            <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
              <p className="text-2xl font-bold text-neon-purple">{errorStats.noTemplate}</p>
              <p className="text-xs text-gray-400">Sin plantilla</p>
            </div>
            <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
              <p className="text-2xl font-bold text-accent-warning">{errorStats.templateError}</p>
              <p className="text-xs text-gray-400">Error plantilla</p>
            </div>
            <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
              <p className="text-2xl font-bold text-gray-400">{errorStats.maxDaily}</p>
              <p className="text-xs text-gray-400">Limite diario</p>
            </div>
          </div>

          <div className="card overflow-hidden p-0">
            <div className="p-4 border-b border-dark-border flex items-center justify-between">
              <h3 className="font-semibold text-white">Errores y problemas ({errorReminders.length})</h3>
              <button
                onClick={handleManualRefresh}
                disabled={refreshing}
                className="p-2 hover:bg-dark-hover rounded-lg transition-colors"
              >
                <svg className={`w-5 h-5 text-gray-400 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>
            
            {errorReminders.length === 0 ? (
              <div className="p-8 text-center">
                <svg className="w-12 h-12 text-accent-success mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-gray-400">Sin errores recientes</p>
              </div>
            ) : (
              <div className="divide-y divide-dark-border">
                {errorReminders.map(reminder => (
                  <div key={reminder.id} className="p-4 hover:bg-dark-hover/50 transition-colors">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium text-white truncate">
                            {reminder.contactName || reminder.contactPhone}
                          </p>
                          {getStatusBadge(reminder.status)}
                        </div>
                        <p className="text-sm text-gray-400 mt-1">
                          {formatDate(reminder.scheduledAt)}
                        </p>
                        {reminder.lastError && (
                          <div className="mt-2 p-2 bg-accent-error/10 rounded border border-accent-error/20">
                            <p className="text-xs text-accent-error font-mono break-all">
                              {reminder.lastError}
                            </p>
                          </div>
                        )}
                      </div>
                      {['failed', 'template_error'].includes(reminder.status) && (
                        <button
                          onClick={() => handleRetryReminder(reminder.id)}
                          disabled={retrying === reminder.id}
                          className="px-3 py-1.5 text-sm bg-neon-blue/10 text-neon-blue hover:bg-neon-blue/20 rounded-lg transition-colors flex items-center gap-1"
                        >
                          {retrying === reminder.id ? (
                            <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          ) : (
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          )}
                          Reintentar
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-8 p-4 bg-neon-blue/10 rounded-xl border border-neon-blue/20">
        <h4 className="font-medium text-neon-blue mb-2">Como funciona</h4>
        <ul className="text-sm text-gray-300 space-y-2">
          <li><strong>Pasos dinamicos:</strong> Agrega tantos recordatorios como necesites, cada uno con su propio delay y nivel de presion.</li>
          <li><strong>Cola en tiempo real:</strong> Visualiza todos los recordatorios pendientes con tiempo restante.</li>
          <li><strong>Logs de errores:</strong> Monitorea fallos y reintenta los que se pueden recuperar.</li>
        </ul>
      </div>
    </div>
  );
}

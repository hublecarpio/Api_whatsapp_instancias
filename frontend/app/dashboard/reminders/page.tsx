'use client';

import { useState, useEffect } from 'react';
import { useBusinessStore } from '@/store/business';
import { remindersApi } from '@/lib/api';

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
  messageTemplate?: string;
  generatedMessage?: string;
}

export default function RemindersPage() {
  const { currentBusiness } = useBusinessStore();
  const [config, setConfig] = useState<FollowUpConfig | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'config' | 'pending' | 'history'>('config');

  useEffect(() => {
    if (currentBusiness) {
      fetchData();
    }
  }, [currentBusiness]);

  const fetchData = async () => {
    if (!currentBusiness) return;
    setLoading(true);
    try {
      const [configRes, remindersRes] = await Promise.all([
        remindersApi.getConfig(currentBusiness.id),
        remindersApi.list(currentBusiness.id)
      ]);
      setConfig(configRes.data);
      setReminders(remindersRes.data);
    } catch (err) {
      console.error('Error loading data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveConfig = async () => {
    if (!currentBusiness || !config) return;
    setSaving(true);
    try {
      await remindersApi.updateConfig(currentBusiness.id, config);
    } catch (err) {
      console.error('Error saving config:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleCancelReminder = async (id: string) => {
    try {
      await remindersApi.cancel(id);
      fetchData();
    } catch (err) {
      console.error('Error cancelling reminder:', err);
    }
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleString('es-MX', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      pending: 'bg-accent-warning/20 text-accent-warning',
      executed: 'bg-accent-success/20 text-accent-success',
      cancelled: 'bg-dark-hover text-gray-400',
      failed: 'bg-accent-error/20 text-accent-error',
      skipped: 'bg-neon-blue/20 text-neon-blue',
      max_daily_reached: 'bg-accent-warning/20 text-accent-warning'
    };
    const labels: Record<string, string> = {
      pending: 'Pendiente',
      executed: 'Enviado',
      cancelled: 'Cancelado',
      failed: 'Fallido',
      skipped: 'Omitido',
      max_daily_reached: 'Limite diario'
    };
    return (
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[status] || 'bg-dark-hover text-gray-400'}`}>
        {labels[status] || status}
      </span>
    );
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

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-white">Seguimiento Automatico</h1>
        <p className="text-gray-400 text-sm mt-1">
          Configura el seguimiento automatico para clientes que no responden
        </p>
      </div>

      <div className="flex gap-2 mb-6 overflow-x-auto hide-scrollbar">
        {(['config', 'pending', 'history'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-lg transition-colors whitespace-nowrap ${
              activeTab === tab 
                ? 'bg-neon-blue text-dark-bg' 
                : 'bg-dark-card text-gray-400 hover:bg-dark-hover'
            }`}
          >
            {tab === 'config' ? 'Configuracion' : tab === 'pending' ? 'Pendientes' : 'Historial'}
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Primer seguimiento (minutos)
              </label>
              <input
                type="number"
                value={config.firstDelayMinutes}
                onChange={(e) => setConfig({ ...config, firstDelayMinutes: parseInt(e.target.value) || 15 })}
                className="input"
                min={1}
              />
              <p className="text-xs text-gray-500 mt-1">Tiempo despues de nuestra ultima respuesta</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Segundo seguimiento (minutos)
              </label>
              <input
                type="number"
                value={config.secondDelayMinutes}
                onChange={(e) => setConfig({ ...config, secondDelayMinutes: parseInt(e.target.value) || 60 })}
                className="input"
                min={1}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Tercer seguimiento (minutos)
              </label>
              <input
                type="number"
                value={config.thirdDelayMinutes}
                onChange={(e) => setConfig({ ...config, thirdDelayMinutes: parseInt(e.target.value) || 240 })}
                className="input"
                min={1}
              />
            </div>

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
                max={10}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Nivel de presion
              </label>
              <select
                value={config.pressureLevel}
                onChange={(e) => setConfig({ ...config, pressureLevel: parseInt(e.target.value) })}
                className="input"
              >
                <option value={1}>1 - Muy sutil</option>
                <option value={2}>2 - Amigable</option>
                <option value={3}>3 - Directo</option>
                <option value={4}>4 - Con urgencia</option>
                <option value={5}>5 - Agresivo</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">Que tan insistente sera el mensaje</p>
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

      {activeTab === 'pending' && (
        <div className="card overflow-hidden p-0">
          <div className="p-4 border-b border-dark-border">
            <h3 className="font-semibold text-white">Recordatorios pendientes</h3>
          </div>
          {reminders.filter(r => r.status === 'pending').length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No hay recordatorios pendientes
            </div>
          ) : (
            <div className="divide-y divide-dark-border">
              {reminders.filter(r => r.status === 'pending').map(reminder => (
                <div key={reminder.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-dark-hover transition-colors">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 bg-neon-blue/20 rounded-full flex items-center justify-center flex-shrink-0">
                      <svg className="w-5 h-5 text-neon-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-white truncate">
                        {reminder.contactName || reminder.contactPhone}
                      </p>
                      <p className="text-sm text-gray-400">
                        Programado: {formatDate(reminder.scheduledAt)} - Intento #{reminder.attemptNumber}
                      </p>
                      {reminder.messageTemplate && (
                        <p className="text-xs text-gray-500 mt-1 truncate">
                          {reminder.messageTemplate}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 justify-end">
                    <span className={`text-xs px-2 py-1 rounded ${reminder.type === 'manual' ? 'bg-neon-blue/20 text-neon-blue' : 'bg-dark-hover text-gray-400'}`}>
                      {reminder.type === 'manual' ? 'Manual' : 'Automatico'}
                    </span>
                    <button
                      onClick={() => handleCancelReminder(reminder.id)}
                      className="text-accent-error hover:text-red-400 text-sm"
                    >
                      Cancelar
                    </button>
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
            <h3 className="font-semibold text-white">Historial de seguimientos</h3>
          </div>
          {reminders.filter(r => r.status !== 'pending').length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No hay historial de seguimientos
            </div>
          ) : (
            <div className="divide-y divide-dark-border">
              {reminders.filter(r => r.status !== 'pending').slice(0, 50).map(reminder => (
                <div key={reminder.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-dark-hover transition-colors">
                  <div className="min-w-0">
                    <p className="font-medium text-white truncate">
                      {reminder.contactName || reminder.contactPhone}
                    </p>
                    <p className="text-sm text-gray-400">
                      {formatDate(reminder.executedAt || reminder.scheduledAt)}
                    </p>
                    {reminder.generatedMessage && (
                      <p className="text-xs text-gray-500 mt-1 truncate">
                        {reminder.generatedMessage}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 justify-end">
                    {getStatusBadge(reminder.status)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-8 p-4 bg-neon-blue/10 rounded-xl border border-neon-blue/20">
        <h4 className="font-medium text-neon-blue mb-2">Como funciona</h4>
        <ul className="text-sm text-gray-300 space-y-1">
          <li>1. Cuando respondes a un cliente y el no contesta, el sistema espera el tiempo configurado</li>
          <li>2. Despues del primer tiempo sin respuesta, se envia un mensaje de seguimiento automatico</li>
          <li>3. El mensaje se genera con IA basado en la conversacion para que sea coherente</li>
          <li>4. El nivel de presion aumenta con cada intento segun tu configuracion</li>
          <li>5. Respetamos el horario permitido y el maximo de intentos diarios</li>
        </ul>
      </div>
    </div>
  );
}

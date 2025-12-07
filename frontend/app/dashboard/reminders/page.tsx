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
      pending: 'bg-yellow-100 text-yellow-800',
      executed: 'bg-green-100 text-green-800',
      cancelled: 'bg-gray-100 text-gray-800',
      failed: 'bg-red-100 text-red-800',
      skipped: 'bg-blue-100 text-blue-800',
      max_daily_reached: 'bg-orange-100 text-orange-800'
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
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-100'}`}>
        {labels[status] || status}
      </span>
    );
  };

  if (!currentBusiness) {
    return (
      <div className="p-6 text-center text-gray-500">
        Primero selecciona una empresa.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6 flex justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600"></div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Seguimiento Automatico</h1>
        <p className="text-gray-500 text-sm mt-1">
          Configura el seguimiento automatico para clientes que no responden
        </p>
      </div>

      <div className="flex gap-2 mb-6">
        {(['config', 'pending', 'history'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-lg transition-colors ${
              activeTab === tab 
                ? 'bg-green-600 text-white' 
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {tab === 'config' ? 'Configuracion' : tab === 'pending' ? 'Pendientes' : 'Historial'}
          </button>
        ))}
      </div>

      {activeTab === 'config' && config && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="font-semibold text-lg">Seguimiento automatico</h3>
              <p className="text-sm text-gray-500">El sistema enviara mensajes cuando el cliente no responda</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 rounded-full peer peer-checked:bg-green-600 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Primer seguimiento (minutos)
              </label>
              <input
                type="number"
                value={config.firstDelayMinutes}
                onChange={(e) => setConfig({ ...config, firstDelayMinutes: parseInt(e.target.value) || 15 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                min={1}
              />
              <p className="text-xs text-gray-500 mt-1">Tiempo despues de nuestra ultima respuesta</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Segundo seguimiento (minutos)
              </label>
              <input
                type="number"
                value={config.secondDelayMinutes}
                onChange={(e) => setConfig({ ...config, secondDelayMinutes: parseInt(e.target.value) || 60 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                min={1}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Tercer seguimiento (minutos)
              </label>
              <input
                type="number"
                value={config.thirdDelayMinutes}
                onChange={(e) => setConfig({ ...config, thirdDelayMinutes: parseInt(e.target.value) || 240 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                min={1}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Maximo intentos por dia
              </label>
              <input
                type="number"
                value={config.maxDailyAttempts}
                onChange={(e) => setConfig({ ...config, maxDailyAttempts: parseInt(e.target.value) || 3 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                min={1}
                max={10}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Nivel de presion
              </label>
              <select
                value={config.pressureLevel}
                onChange={(e) => setConfig({ ...config, pressureLevel: parseInt(e.target.value) })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
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
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Horario permitido
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={config.allowedStartHour}
                  onChange={(e) => setConfig({ ...config, allowedStartHour: parseInt(e.target.value) || 9 })}
                  className="w-20 px-3 py-2 border border-gray-300 rounded-lg"
                  min={0}
                  max={23}
                />
                <span>a</span>
                <input
                  type="number"
                  value={config.allowedEndHour}
                  onChange={(e) => setConfig({ ...config, allowedEndHour: parseInt(e.target.value) || 21 })}
                  className="w-20 px-3 py-2 border border-gray-300 rounded-lg"
                  min={0}
                  max={23}
                />
                <span>hrs</span>
              </div>
            </div>
          </div>

          <div className="mt-6 flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.weekendsEnabled}
                onChange={(e) => setConfig({ ...config, weekendsEnabled: e.target.checked })}
                className="w-4 h-4 text-green-600 rounded"
              />
              <span className="text-sm text-gray-700">Enviar en fines de semana</span>
            </label>
          </div>

          <div className="mt-8 flex justify-end">
            <button
              onClick={handleSaveConfig}
              disabled={saving}
              className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              {saving ? 'Guardando...' : 'Guardar configuracion'}
            </button>
          </div>
        </div>
      )}

      {activeTab === 'pending' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="p-4 border-b border-gray-200">
            <h3 className="font-semibold">Recordatorios pendientes</h3>
          </div>
          {reminders.filter(r => r.status === 'pending').length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No hay recordatorios pendientes
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {reminders.filter(r => r.status === 'pending').map(reminder => (
                <div key={reminder.id} className="p-4 flex items-center justify-between hover:bg-gray-50">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                      <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">
                        {reminder.contactName || reminder.contactPhone}
                      </p>
                      <p className="text-sm text-gray-500">
                        Programado: {formatDate(reminder.scheduledAt)} - Intento #{reminder.attemptNumber}
                      </p>
                      {reminder.messageTemplate && (
                        <p className="text-xs text-gray-400 mt-1 truncate max-w-md">
                          {reminder.messageTemplate}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-xs px-2 py-1 rounded ${reminder.type === 'manual' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>
                      {reminder.type === 'manual' ? 'Manual' : 'Automatico'}
                    </span>
                    <button
                      onClick={() => handleCancelReminder(reminder.id)}
                      className="text-red-600 hover:text-red-800 text-sm"
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
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="p-4 border-b border-gray-200">
            <h3 className="font-semibold">Historial de seguimientos</h3>
          </div>
          {reminders.filter(r => r.status !== 'pending').length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No hay historial de seguimientos
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {reminders.filter(r => r.status !== 'pending').slice(0, 50).map(reminder => (
                <div key={reminder.id} className="p-4 flex items-center justify-between hover:bg-gray-50">
                  <div className="flex items-center gap-4">
                    <div>
                      <p className="font-medium text-gray-900">
                        {reminder.contactName || reminder.contactPhone}
                      </p>
                      <p className="text-sm text-gray-500">
                        {formatDate(reminder.executedAt || reminder.scheduledAt)}
                      </p>
                      {reminder.generatedMessage && (
                        <p className="text-xs text-gray-400 mt-1 truncate max-w-md">
                          {reminder.generatedMessage}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {getStatusBadge(reminder.status)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-8 p-4 bg-blue-50 rounded-xl border border-blue-200">
        <h4 className="font-medium text-blue-900 mb-2">Como funciona</h4>
        <ul className="text-sm text-blue-800 space-y-1">
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

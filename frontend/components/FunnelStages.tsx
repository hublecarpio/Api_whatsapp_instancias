'use client';

import { useState, useEffect } from 'react';
import { funnelStagesApi } from '@/lib/api';

interface ExtractionField {
  id: string;
  fieldKey: string;
  fieldLabel: string;
  fieldType: string;
}

interface FunnelStage {
  id: string;
  name: string;
  description: string | null;
  promptContext: string | null;
  requiredFieldKeys: string[];
  blockedTopics: string[];
  isActive: boolean;
  order: number;
}

interface FunnelStagesProps {
  businessId: string;
  instanceId?: string | null;
}

export default function FunnelStages({ businessId, instanceId }: FunnelStagesProps) {
  const [stages, setStages] = useState<FunnelStage[]>([]);
  const [fields, setFields] = useState<ExtractionField[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingStage, setEditingStage] = useState<FunnelStage | null>(null);
  const [newTopic, setNewTopic] = useState('');

  const [form, setForm] = useState({
    name: '',
    description: '',
    promptContext: '',
    requiredFieldKeys: [] as string[],
    blockedTopics: [] as string[]
  });

  useEffect(() => {
    loadData();
  }, [businessId, instanceId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [stagesRes, fieldsRes] = await Promise.all([
        funnelStagesApi.list(businessId, instanceId || undefined),
        funnelStagesApi.getExtractionFields(businessId)
      ]);
      setStages(stagesRes.data);
      setFields(fieldsRes.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error cargando datos');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('El nombre es requerido');
      return;
    }

    try {
      setSaving(true);
      setError('');

      const data = {
        name: form.name.trim(),
        description: form.description || undefined,
        promptContext: form.promptContext || undefined,
        requiredFieldKeys: form.requiredFieldKeys,
        blockedTopics: form.blockedTopics,
        instanceId: instanceId || undefined
      };

      if (editingStage) {
        await funnelStagesApi.update(businessId, editingStage.id, data);
        setSuccess('Etapa actualizada');
      } else {
        await funnelStagesApi.create(businessId, data);
        setSuccess('Etapa creada');
      }

      resetForm();
      loadData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error guardando etapa');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (stage: FunnelStage) => {
    setEditingStage(stage);
    setForm({
      name: stage.name,
      description: stage.description || '',
      promptContext: stage.promptContext || '',
      requiredFieldKeys: stage.requiredFieldKeys || [],
      blockedTopics: stage.blockedTopics || []
    });
    setShowForm(true);
  };

  const handleDelete = async (stageId: string) => {
    if (!confirm('Eliminar esta etapa del flujo de venta?')) return;

    try {
      await funnelStagesApi.delete(businessId, stageId);
      setSuccess('Etapa eliminada');
      loadData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error eliminando etapa');
    }
  };

  const handleToggleActive = async (stage: FunnelStage) => {
    try {
      await funnelStagesApi.update(businessId, stage.id, { isActive: !stage.isActive });
      loadData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error actualizando etapa');
    }
  };

  const resetForm = () => {
    setForm({ name: '', description: '', promptContext: '', requiredFieldKeys: [], blockedTopics: [] });
    setEditingStage(null);
    setShowForm(false);
    setNewTopic('');
  };

  const handleFieldToggle = (fieldKey: string) => {
    setForm(prev => ({
      ...prev,
      requiredFieldKeys: prev.requiredFieldKeys.includes(fieldKey)
        ? prev.requiredFieldKeys.filter(k => k !== fieldKey)
        : [...prev.requiredFieldKeys, fieldKey]
    }));
  };

  const handleAddTopic = () => {
    if (newTopic.trim() && !form.blockedTopics.includes(newTopic.trim())) {
      setForm(prev => ({
        ...prev,
        blockedTopics: [...prev.blockedTopics, newTopic.trim()]
      }));
      setNewTopic('');
    }
  };

  const handleRemoveTopic = (topic: string) => {
    setForm(prev => ({
      ...prev,
      blockedTopics: prev.blockedTopics.filter(t => t !== topic)
    }));
  };

  const moveStage = async (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= stages.length) return;

    const newStages = [...stages];
    [newStages[index], newStages[newIndex]] = [newStages[newIndex], newStages[index]];

    try {
      await funnelStagesApi.reorder(businessId, newStages.map(s => s.id));
      setStages(newStages);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error reordenando');
    }
  };

  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(''), 3000);
      return () => clearTimeout(timer);
    }
  }, [success]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-lg font-semibold text-white">Flujo de Venta</h3>
          <p className="text-sm text-gray-400">
            Configura etapas secuenciales que guian la conversacion. El agente recolectara datos obligatorios antes de avanzar.
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Nueva Etapa
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-500/20 border border-red-500/30 rounded-lg text-red-400">
          {error}
        </div>
      )}

      {success && (
        <div className="p-3 bg-green-500/20 border border-green-500/30 rounded-lg text-green-400">
          {success}
        </div>
      )}

      {showForm && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
          <h4 className="text-lg font-medium text-white mb-4">
            {editingStage ? 'Editar Etapa' : 'Nueva Etapa'}
          </h4>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Nombre de la etapa</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Ej: Recoleccion de datos"
                className="w-full px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">Descripcion (opcional)</label>
              <input
                type="text"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Descripcion breve de esta etapa"
                className="w-full px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">
                Campos obligatorios para avanzar
              </label>
              <p className="text-xs text-gray-500 mb-2">
                El cliente no podra pasar a la siguiente etapa hasta proporcionar estos datos
              </p>
              <div className="flex flex-wrap gap-2 p-3 bg-gray-900 border border-gray-700 rounded-lg min-h-[60px]">
                {fields.length === 0 ? (
                  <span className="text-gray-500 text-sm">No hay campos de extraccion configurados</span>
                ) : (
                  fields.map(field => (
                    <button
                      key={field.fieldKey}
                      type="button"
                      onClick={() => handleFieldToggle(field.fieldKey)}
                      className={`px-3 py-1 rounded-full text-sm transition-colors ${
                        form.requiredFieldKeys.includes(field.fieldKey)
                          ? 'bg-green-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      {field.fieldLabel}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">
                Temas bloqueados hasta completar esta etapa
              </label>
              <p className="text-xs text-gray-500 mb-2">
                El agente evitara mencionar estos temas hasta que se completen los campos obligatorios
              </p>
              <div className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={newTopic}
                  onChange={(e) => setNewTopic(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddTopic(); } }}
                  placeholder="Ej: precios, pagos, envios"
                  className="flex-1 px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white"
                />
                <button
                  type="button"
                  onClick={handleAddTopic}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg"
                >
                  Agregar
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {form.blockedTopics.map((topic, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 px-3 py-1 bg-red-600/20 text-red-400 rounded-full text-sm"
                  >
                    {topic}
                    <button
                      type="button"
                      onClick={() => handleRemoveTopic(topic)}
                      className="hover:text-red-300"
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">
                Instrucciones adicionales para el agente (opcional)
              </label>
              <textarea
                value={form.promptContext}
                onChange={(e) => setForm({ ...form, promptContext: e.target.value })}
                placeholder="Instrucciones especificas para el agente cuando este en esta etapa..."
                rows={3}
                className="w-full px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white resize-none"
              />
            </div>

            <div className="flex justify-end gap-3 pt-4">
              <button
                type="button"
                onClick={resetForm}
                className="px-4 py-2 text-gray-400 hover:text-white"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg disabled:opacity-50"
              >
                {saving ? 'Guardando...' : (editingStage ? 'Actualizar' : 'Crear Etapa')}
              </button>
            </div>
          </form>
        </div>
      )}

      {stages.length === 0 && !showForm ? (
        <div className="text-center py-12 bg-gray-800/30 rounded-xl border border-gray-700/50">
          <svg className="w-16 h-16 mx-auto text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
          <h3 className="text-lg font-medium text-gray-300 mb-2">Sin etapas configuradas</h3>
          <p className="text-gray-500 mb-4">
            Crea etapas para guiar la conversacion y recolectar datos de forma secuencial
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg"
          >
            Crear primera etapa
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {stages.map((stage, index) => (
            <div
              key={stage.id}
              className={`bg-gray-800/50 border rounded-xl p-4 ${
                stage.isActive ? 'border-gray-700' : 'border-gray-800 opacity-60'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex flex-col gap-1">
                    <button
                      onClick={() => moveStage(index, 'up')}
                      disabled={index === 0}
                      className="p-1 text-gray-500 hover:text-white disabled:opacity-30"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                      </svg>
                    </button>
                    <button
                      onClick={() => moveStage(index, 'down')}
                      disabled={index === stages.length - 1}
                      className="p-1 text-gray-500 hover:text-white disabled:opacity-30"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center justify-center w-6 h-6 bg-green-600/20 text-green-400 rounded-full text-sm font-medium">
                        {index + 1}
                      </span>
                      <h4 className="font-medium text-white">{stage.name}</h4>
                      {!stage.isActive && (
                        <span className="text-xs px-2 py-0.5 bg-gray-700 text-gray-400 rounded">Inactiva</span>
                      )}
                    </div>
                    {stage.description && (
                      <p className="text-sm text-gray-400 mt-1">{stage.description}</p>
                    )}
                    <div className="flex flex-wrap gap-4 mt-3">
                      {stage.requiredFieldKeys.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-xs text-gray-500">Campos:</span>
                          {stage.requiredFieldKeys.map(key => {
                            const field = fields.find(f => f.fieldKey === key);
                            return (
                              <span key={key} className="px-2 py-0.5 bg-blue-600/20 text-blue-400 rounded text-xs">
                                {field?.fieldLabel || key}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {stage.blockedTopics.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-xs text-gray-500">Bloqueados:</span>
                          {stage.blockedTopics.map((topic, idx) => (
                            <span key={idx} className="px-2 py-0.5 bg-red-600/20 text-red-400 rounded text-xs">
                              {topic}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleToggleActive(stage)}
                    className={`p-2 rounded-lg transition-colors ${
                      stage.isActive 
                        ? 'text-green-400 hover:bg-green-500/20' 
                        : 'text-gray-500 hover:bg-gray-700'
                    }`}
                    title={stage.isActive ? 'Desactivar' : 'Activar'}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      {stage.isActive ? (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      ) : (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                      )}
                    </svg>
                  </button>
                  <button
                    onClick={() => handleEdit(stage)}
                    className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg"
                    title="Editar"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDelete(stage.id)}
                    className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-500/20 rounded-lg"
                    title="Eliminar"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {stages.length > 0 && (
        <div className="p-4 bg-gray-800/30 border border-gray-700/50 rounded-xl">
          <h4 className="text-sm font-medium text-gray-300 mb-2">Como funciona</h4>
          <ul className="text-sm text-gray-500 space-y-1">
            <li>1. Cada cliente nuevo inicia en la primera etapa activa</li>
            <li>2. El agente solicita los campos obligatorios de esa etapa</li>
            <li>3. Los temas bloqueados no se mencionan hasta completar los campos</li>
            <li>4. Al completar todos los campos, el cliente avanza automaticamente</li>
          </ul>
        </div>
      )}
    </div>
  );
}

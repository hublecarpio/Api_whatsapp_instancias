'use client';

import { useState, useEffect } from 'react';
import { useBusinessStore } from '@/store/business';
import { extractionApi } from '@/lib/api';

interface ExtractionField {
  id: string;
  fieldKey: string;
  fieldLabel: string;
  fieldType: string;
  description: string;
  required: boolean;
  useForAppointment: boolean;
  enabled: boolean;
  order: number;
}

const FIELD_TYPES = [
  { value: 'text', label: 'Texto' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Telefono' },
  { value: 'number', label: 'Numero' },
  { value: 'date', label: 'Fecha' },
  { value: 'address', label: 'Direccion' },
];

export default function ExtractionPage() {
  const { currentBusiness } = useBusinessStore();
  const [fields, setFields] = useState<ExtractionField[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingField, setEditingField] = useState<ExtractionField | null>(null);
  
  const [formData, setFormData] = useState({
    fieldKey: '',
    fieldLabel: '',
    fieldType: 'text',
    description: '',
    required: false,
    useForAppointment: false,
  });

  useEffect(() => {
    if (currentBusiness?.id) {
      loadFields();
    }
  }, [currentBusiness?.id]);

  useEffect(() => {
    if (success || error) {
      const timer = setTimeout(() => {
        setSuccess('');
        setError('');
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [success, error]);

  const loadFields = async () => {
    try {
      setLoading(true);
      const response = await extractionApi.getFields(currentBusiness!.id);
      setFields(response.data);
    } catch (err: any) {
      setError('Error al cargar campos');
    } finally {
      setLoading(false);
    }
  };

  const handleAddField = async () => {
    if (!formData.fieldLabel.trim()) {
      setError('El nombre del campo es requerido');
      return;
    }

    try {
      setSaving(true);
      setError('');
      
      const fieldKey = formData.fieldKey.trim() || 
        formData.fieldLabel.toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/\s+/g, '_')
          .replace(/[^a-z0-9_]/g, '');

      await extractionApi.createField(currentBusiness!.id, {
        fieldKey,
        fieldLabel: formData.fieldLabel.trim(),
        fieldType: formData.fieldType,
        description: formData.description.trim(),
        required: formData.required,
        useForAppointment: formData.useForAppointment,
      });

      setSuccess('Campo creado');
      setShowAddModal(false);
      resetForm();
      loadFields();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al crear campo');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateField = async () => {
    if (!editingField) return;

    try {
      setSaving(true);
      setError('');
      
      await extractionApi.updateField(currentBusiness!.id, editingField.id, {
        fieldLabel: formData.fieldLabel.trim(),
        fieldType: formData.fieldType,
        description: formData.description.trim(),
        required: formData.required,
        useForAppointment: formData.useForAppointment,
      });

      setSuccess('Campo actualizado');
      setEditingField(null);
      resetForm();
      loadFields();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al actualizar');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteField = async (fieldId: string) => {
    if (!confirm('Eliminar este campo?')) return;

    try {
      await extractionApi.deleteField(currentBusiness!.id, fieldId);
      setSuccess('Campo eliminado');
      loadFields();
    } catch (err: any) {
      setError('Error al eliminar');
    }
  };

  const handleToggleEnabled = async (field: ExtractionField) => {
    try {
      await extractionApi.updateField(currentBusiness!.id, field.id, {
        enabled: !field.enabled,
      });
      loadFields();
    } catch (err: any) {
      setError('Error al actualizar');
    }
  };

  const resetForm = () => {
    setFormData({
      fieldKey: '',
      fieldLabel: '',
      fieldType: 'text',
      description: '',
      required: false,
      useForAppointment: false,
    });
  };

  const openEditModal = (field: ExtractionField) => {
    setEditingField(field);
    setFormData({
      fieldKey: field.fieldKey,
      fieldLabel: field.fieldLabel,
      fieldType: field.fieldType,
      description: field.description || '',
      required: field.required,
      useForAppointment: field.useForAppointment,
    });
  };

  if (!currentBusiness) {
    return (
      <div className="p-6">
        <p className="text-gray-400">Selecciona un negocio primero</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Datos Personalizados</h1>
          <p className="text-gray-400 mt-1">
            Configura que datos extraer automaticamente de las conversaciones
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="btn btn-primary flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Agregar Campo
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-accent-error/20 border border-accent-error/50 text-accent-error rounded-lg">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 p-3 bg-accent-success/20 border border-accent-success/50 text-accent-success rounded-lg">
          {success}
        </div>
      )}

      <div className="bg-dark-card rounded-xl border border-dark-border overflow-hidden">
        <div className="p-4 border-b border-dark-border bg-dark-surface">
          <div className="grid grid-cols-12 gap-4 text-sm font-medium text-gray-400">
            <div className="col-span-3">Campo</div>
            <div className="col-span-2">Tipo</div>
            <div className="col-span-3">Descripcion</div>
            <div className="col-span-1 text-center">Requerido</div>
            <div className="col-span-1 text-center">Citas</div>
            <div className="col-span-2 text-center">Acciones</div>
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-gray-500">Cargando...</div>
        ) : fields.length === 0 ? (
          <div className="p-12 text-center">
            <svg className="w-12 h-12 mx-auto text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-gray-300 mb-2">No hay campos configurados</p>
            <p className="text-gray-500 text-sm">
              Agrega campos como email, direccion, motivo de consulta, etc.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-dark-border">
            {fields.map((field) => (
              <div 
                key={field.id} 
                className={`p-4 grid grid-cols-12 gap-4 items-center hover:bg-dark-hover transition-colors ${!field.enabled ? 'opacity-50' : ''}`}
              >
                <div className="col-span-3">
                  <div className="font-medium text-white">{field.fieldLabel}</div>
                  <div className="text-xs text-gray-500 font-mono">{field.fieldKey}</div>
                </div>
                <div className="col-span-2">
                  <span className="px-2 py-1 bg-dark-surface text-gray-300 rounded text-sm border border-dark-border">
                    {FIELD_TYPES.find(t => t.value === field.fieldType)?.label || field.fieldType}
                  </span>
                </div>
                <div className="col-span-3 text-sm text-gray-400 truncate">
                  {field.description || '-'}
                </div>
                <div className="col-span-1 text-center">
                  {field.required ? (
                    <span className="text-neon-blue">Si</span>
                  ) : (
                    <span className="text-gray-600">No</span>
                  )}
                </div>
                <div className="col-span-1 text-center">
                  {field.useForAppointment ? (
                    <span className="text-accent-purple">Si</span>
                  ) : (
                    <span className="text-gray-600">No</span>
                  )}
                </div>
                <div className="col-span-2 flex items-center justify-center gap-2">
                  <button
                    onClick={() => handleToggleEnabled(field)}
                    className={`p-1.5 rounded transition-colors ${field.enabled ? 'text-accent-success hover:bg-accent-success/20' : 'text-gray-500 hover:bg-dark-hover'}`}
                    title={field.enabled ? 'Desactivar' : 'Activar'}
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={field.enabled ? "M5 13l4 4L19 7" : "M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"} />
                    </svg>
                  </button>
                  <button
                    onClick={() => openEditModal(field)}
                    className="p-1.5 text-neon-blue hover:bg-neon-blue/20 rounded transition-colors"
                    title="Editar"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDeleteField(field.id)}
                    className="p-1.5 text-accent-error hover:bg-accent-error/20 rounded transition-colors"
                    title="Eliminar"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-6 p-4 bg-neon-blue/10 border border-neon-blue/30 rounded-xl">
        <h3 className="font-medium text-neon-blue mb-2">Como funciona</h3>
        <ul className="text-sm text-gray-300 space-y-1">
          <li>La IA extrae automaticamente estos datos de las conversaciones</li>
          <li>Los campos marcados como "Citas" se usan en la herramienta de agendar</li>
          <li>Puedes ver y editar los datos en el panel de chat de cada contacto</li>
          <li>Las ediciones manuales tienen prioridad y no se sobreescriben</li>
        </ul>
      </div>

      {(showAddModal || editingField) && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-dark-card rounded-xl border border-dark-border shadow-2xl max-w-lg w-full">
            <div className="p-4 border-b border-dark-border flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">
                {editingField ? 'Editar Campo' : 'Nuevo Campo'}
              </h2>
              <button
                onClick={() => { setShowAddModal(false); setEditingField(null); resetForm(); }}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Nombre del Campo *
                </label>
                <input
                  type="text"
                  value={formData.fieldLabel}
                  onChange={(e) => setFormData({ ...formData, fieldLabel: e.target.value })}
                  className="input"
                  placeholder="Ej: Email, Direccion, Motivo de Consulta"
                />
              </div>

              {!editingField && (
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    Clave (opcional)
                  </label>
                  <input
                    type="text"
                    value={formData.fieldKey}
                    onChange={(e) => setFormData({ ...formData, fieldKey: e.target.value })}
                    className="input font-mono text-sm"
                    placeholder="Se genera del nombre"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Tipo de Dato
                </label>
                <select
                  value={formData.fieldType}
                  onChange={(e) => setFormData({ ...formData, fieldType: e.target.value })}
                  className="input"
                >
                  {FIELD_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>{type.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Descripcion para la IA
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="input resize-none"
                  rows={2}
                  placeholder="Describe que dato debe extraer. Ej: 'El motivo de la consulta del cliente'"
                />
              </div>

              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.required}
                    onChange={(e) => setFormData({ ...formData, required: e.target.checked })}
                    className="w-4 h-4 rounded bg-dark-surface border-dark-border text-neon-blue focus:ring-neon-blue/50"
                  />
                  <span className="text-sm text-gray-300">Requerido</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.useForAppointment}
                    onChange={(e) => setFormData({ ...formData, useForAppointment: e.target.checked })}
                    className="w-4 h-4 rounded bg-dark-surface border-dark-border text-accent-purple focus:ring-accent-purple/50"
                  />
                  <span className="text-sm text-gray-300">Usar para Citas</span>
                </label>
              </div>
            </div>

            <div className="p-4 border-t border-dark-border flex justify-end gap-3">
              <button
                onClick={() => { setShowAddModal(false); setEditingField(null); resetForm(); }}
                className="btn btn-secondary"
              >
                Cancelar
              </button>
              <button
                onClick={editingField ? handleUpdateField : handleAddField}
                disabled={saving || !formData.fieldLabel.trim()}
                className="btn btn-primary"
              >
                {saving ? 'Guardando...' : (editingField ? 'Actualizar' : 'Crear')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

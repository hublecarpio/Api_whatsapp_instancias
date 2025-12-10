'use client';

import { useEffect, useState } from 'react';
import { extractionApi } from '@/lib/api';

interface ExtractionField {
  id: string;
  fieldKey: string;
  fieldLabel: string;
  fieldType: string;
  required: boolean;
  enabled: boolean;
  order: number;
}

interface ExtractionFieldsManagerProps {
  businessId: string;
}

export default function ExtractionFieldsManager({ businessId }: ExtractionFieldsManagerProps) {
  const [fields, setFields] = useState<ExtractionField[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newField, setNewField] = useState({ fieldKey: '', fieldLabel: '', required: false });
  const [editingField, setEditingField] = useState<ExtractionField | null>(null);

  useEffect(() => {
    loadFields();
  }, [businessId]);

  const loadFields = async () => {
    try {
      setLoading(true);
      const response = await extractionApi.getFields(businessId);
      setFields(response.data);
    } catch (error) {
      console.error('Error loading extraction fields:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddField = async () => {
    if (!newField.fieldKey || !newField.fieldLabel) return;
    
    try {
      setSaving(true);
      await extractionApi.createField(businessId, {
        fieldKey: newField.fieldKey.toLowerCase().replace(/\s+/g, '_'),
        fieldLabel: newField.fieldLabel,
        required: newField.required
      });
      setNewField({ fieldKey: '', fieldLabel: '', required: false });
      setShowAddModal(false);
      await loadFields();
    } catch (error: any) {
      console.error('Error creating field:', error);
      alert(error.response?.data?.error || 'Error al crear el campo');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateField = async (fieldId: string, updates: Partial<ExtractionField>) => {
    try {
      await extractionApi.updateField(businessId, fieldId, updates);
      setFields(prev => prev.map(f => f.id === fieldId ? { ...f, ...updates } : f));
    } catch (error) {
      console.error('Error updating field:', error);
    }
  };

  const handleDeleteField = async (fieldId: string) => {
    if (!confirm('¿Eliminar este campo? Los datos extraídos no se perderán.')) return;
    
    try {
      await extractionApi.deleteField(businessId, fieldId);
      setFields(prev => prev.filter(f => f.id !== fieldId));
    } catch (error) {
      console.error('Error deleting field:', error);
    }
  };

  const moveField = async (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= fields.length) return;
    
    const newFields = [...fields];
    [newFields[index], newFields[newIndex]] = [newFields[newIndex], newFields[index]];
    setFields(newFields);
    
    try {
      await extractionApi.reorderFields(businessId, newFields.map(f => f.id));
    } catch (error) {
      console.error('Error reordering fields:', error);
      await loadFields();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-500"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-white mb-2">Campos de Extraccion</h2>
        <p className="text-gray-400 text-sm">
          Configura que datos del cliente quieres que el agente extraiga automaticamente de las conversaciones.
        </p>
      </div>

      <div className="bg-[#1e1e1e] rounded-xl border border-gray-700 overflow-hidden">
        <div className="p-4 border-b border-gray-700 flex items-center justify-between">
          <span className="text-gray-400 text-sm">{fields.length} campos configurados</span>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg text-sm transition-colors"
          >
            + Agregar Campo
          </button>
        </div>

        {fields.length === 0 ? (
          <div className="p-8 text-center">
            <div className="text-4xl mb-3">📝</div>
            <p className="text-gray-400">No hay campos configurados</p>
            <p className="text-gray-500 text-sm mt-1">Agrega campos para extraer datos como nombre, direccion, email, etc.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-700">
            {fields.map((field, index) => (
              <div
                key={field.id}
                className={`p-4 flex items-center gap-4 ${!field.enabled ? 'opacity-50' : ''}`}
              >
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => moveField(index, 'up')}
                    disabled={index === 0}
                    className="text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    ▲
                  </button>
                  <button
                    onClick={() => moveField(index, 'down')}
                    disabled={index === fields.length - 1}
                    className="text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    ▼
                  </button>
                </div>

                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium">{field.fieldLabel}</span>
                    {field.required && (
                      <span className="text-xs px-2 py-0.5 bg-red-500/20 text-red-400 rounded">Requerido</span>
                    )}
                  </div>
                  <p className="text-gray-500 text-xs mt-1 font-mono">{field.fieldKey}</p>
                </div>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={field.enabled}
                    onChange={(e) => handleUpdateField(field.id, { enabled: e.target.checked })}
                    className="w-4 h-4 rounded border-gray-600 text-green-500 focus:ring-green-500 focus:ring-offset-0 bg-[#2a2a2a]"
                  />
                  <span className="text-gray-400 text-sm">Activo</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={field.required}
                    onChange={(e) => handleUpdateField(field.id, { required: e.target.checked })}
                    className="w-4 h-4 rounded border-gray-600 text-green-500 focus:ring-green-500 focus:ring-offset-0 bg-[#2a2a2a]"
                  />
                  <span className="text-gray-400 text-sm">Req.</span>
                </label>

                <button
                  onClick={() => handleDeleteField(field.id)}
                  className="text-red-400 hover:text-red-300 p-2"
                  title="Eliminar campo"
                >
                  🗑️
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 bg-[#1a2a1a] rounded-lg p-4 border border-green-900/50">
        <h3 className="text-green-400 font-medium mb-2">Como funciona</h3>
        <ul className="text-gray-400 text-sm space-y-1">
          <li>• El agente de IA extrae estos datos automaticamente de las conversaciones</li>
          <li>• Los datos extraidos se muestran en el panel del chat junto a cada contacto</li>
          <li>• Puedes ver y editar manualmente los datos en cada conversacion</li>
          <li>• Los campos requeridos se priorizan en la extraccion</li>
        </ul>
      </div>

      {showAddModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-[#1e1e1e] rounded-xl border border-gray-700 p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-white mb-4">Agregar Campo de Extraccion</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Etiqueta (visible)</label>
                <input
                  type="text"
                  value={newField.fieldLabel}
                  onChange={(e) => setNewField(prev => ({ 
                    ...prev, 
                    fieldLabel: e.target.value,
                    fieldKey: e.target.value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
                  }))}
                  placeholder="Ej: Direccion de entrega"
                  className="w-full bg-[#2a2a2a] border border-gray-600 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-green-500"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Clave (interna)</label>
                <input
                  type="text"
                  value={newField.fieldKey}
                  onChange={(e) => setNewField(prev => ({ ...prev, fieldKey: e.target.value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') }))}
                  placeholder="direccion_entrega"
                  className="w-full bg-[#2a2a2a] border border-gray-600 rounded-lg px-4 py-2 text-white font-mono focus:outline-none focus:border-green-500"
                />
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newField.required}
                  onChange={(e) => setNewField(prev => ({ ...prev, required: e.target.checked }))}
                  className="w-4 h-4 rounded border-gray-600 text-green-500 focus:ring-green-500 focus:ring-offset-0 bg-[#2a2a2a]"
                />
                <span className="text-gray-300">Campo requerido</span>
              </label>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => { setShowAddModal(false); setNewField({ fieldKey: '', fieldLabel: '', required: false }); }}
                className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleAddField}
                disabled={!newField.fieldKey || !newField.fieldLabel || saving}
                className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Guardando...' : 'Agregar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

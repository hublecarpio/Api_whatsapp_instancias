'use client';

import { useState, useEffect } from 'react';
import { useBusinessStore } from '@/store/business';
import { tagsApi } from '@/lib/api';

interface Tag {
  id: string;
  name: string;
  color: string;
  description?: string;
  order: number;
  isDefault: boolean;
  stagePrompt?: {
    id: string;
    promptOverride?: string;
    systemContext?: string;
  };
  _count?: { assignments: number };
}

export default function TagsPage() {
  const { currentBusiness } = useBusinessStore();
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    color: '#6B7280',
    description: '',
    systemContext: ''
  });

  useEffect(() => {
    if (currentBusiness) {
      fetchTags();
    }
  }, [currentBusiness]);

  const fetchTags = async () => {
    if (!currentBusiness) return;
    setLoading(true);
    try {
      const response = await tagsApi.list(currentBusiness.id);
      setTags(response.data);
      
      if (response.data.length === 0) {
        const initRes = await tagsApi.initDefaults(currentBusiness.id);
        setTags(initRes.data);
      }
    } catch (err) {
      console.error('Failed to fetch tags:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!currentBusiness || !formData.name) return;
    setSaving(true);
    try {
      const newTag = await tagsApi.create({
        business_id: currentBusiness.id,
        name: formData.name,
        color: formData.color,
        description: formData.description
      });
      
      if (formData.systemContext) {
        await tagsApi.setStagePrompt(newTag.data.id, {
          systemContext: formData.systemContext
        });
      }
      
      setFormData({ name: '', color: '#6B7280', description: '', systemContext: '' });
      setShowNewForm(false);
      fetchTags();
    } catch (err) {
      console.error('Failed to create tag:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingTag) return;
    setSaving(true);
    try {
      await tagsApi.update(editingTag.id, {
        name: formData.name,
        color: formData.color,
        description: formData.description
      });
      
      await tagsApi.setStagePrompt(editingTag.id, {
        systemContext: formData.systemContext
      });
      
      setEditingTag(null);
      setFormData({ name: '', color: '#6B7280', description: '', systemContext: '' });
      fetchTags();
    } catch (err) {
      console.error('Failed to update tag:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Seguro que quieres eliminar esta etiqueta? Los contactos asignados perderán esta etapa.')) return;
    try {
      await tagsApi.delete(id);
      fetchTags();
    } catch (err) {
      console.error('Failed to delete tag:', err);
    }
  };

  const startEdit = (tag: Tag) => {
    setEditingTag(tag);
    setFormData({
      name: tag.name,
      color: tag.color,
      description: tag.description || '',
      systemContext: tag.stagePrompt?.systemContext || ''
    });
    setShowNewForm(false);
  };

  const cancelEdit = () => {
    setEditingTag(null);
    setShowNewForm(false);
    setFormData({ name: '', color: '#6B7280', description: '', systemContext: '' });
  };

  const PRESET_COLORS = [
    '#22C55E', '#3B82F6', '#EAB308', '#F97316', '#10B981', '#6B7280',
    '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16', '#F59E0B'
  ];

  if (!currentBusiness) {
    return (
      <div className="p-6 text-center text-gray-500">
        Primero selecciona una empresa para gestionar etiquetas.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Etapas del Cliente</h1>
          <p className="text-gray-500 text-sm mt-1">
            Gestiona las etapas del pipeline de ventas. El agente AI usará esta información para adaptar sus respuestas.
          </p>
        </div>
        <button
          onClick={() => { setShowNewForm(true); setEditingTag(null); }}
          className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Nueva Etapa
        </button>
      </div>

      {(showNewForm || editingTag) && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6 shadow-sm">
          <h3 className="font-semibold text-lg mb-4">
            {editingTag ? 'Editar Etapa' : 'Nueva Etapa'}
          </h3>
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nombre</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Ej: Interesado, Negociando..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Color</label>
              <div className="flex gap-2 flex-wrap">
                {PRESET_COLORS.map(color => (
                  <button
                    key={color}
                    onClick={() => setFormData({ ...formData, color })}
                    className={`w-8 h-8 rounded-full border-2 transition-transform ${
                      formData.color === color ? 'border-gray-900 scale-110' : 'border-transparent hover:scale-105'
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Descripcion (para la IA)
            </label>
            <input
              type="text"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Ej: Cliente que mostro interes en nuestros productos"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-500 mt-1">
              La IA usara esta descripcion para clasificar automaticamente a los clientes en esta etapa.
            </p>
          </div>

          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Instrucciones para esta etapa (opcional)
            </label>
            <textarea
              value={formData.systemContext}
              onChange={(e) => setFormData({ ...formData, systemContext: e.target.value })}
              placeholder="Ej: En esta etapa, enfocate en responder dudas y ofrecer opciones de pago..."
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-500 mt-1">
              Estas instrucciones se agregaran al prompt del agente cuando un contacto este en esta etapa.
            </p>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={cancelEdit}
              className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={editingTag ? handleUpdate : handleCreate}
              disabled={saving || !formData.name}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
            >
              {saving ? 'Guardando...' : (editingTag ? 'Actualizar' : 'Crear')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600"></div>
        </div>
      ) : (
        <div className="space-y-3">
          {tags.map((tag, index) => (
            <div
              key={tag.id}
              className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-4 hover:shadow-md transition-shadow"
            >
              <div className="flex items-center gap-3 text-gray-400">
                <span className="text-sm font-medium">{index + 1}</span>
              </div>
              
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold"
                style={{ backgroundColor: tag.color }}
              >
                {tag.name.charAt(0).toUpperCase()}
              </div>
              
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-gray-900">{tag.name}</h3>
                  {tag.isDefault && (
                    <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                      Predeterminada
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-500 truncate">
                  {tag.description || 'Sin descripcion'}
                </p>
                {tag.stagePrompt?.systemContext && (
                  <p className="text-xs text-green-600 mt-1">
                    Con instrucciones de etapa
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 text-sm text-gray-500">
                <span className="bg-gray-100 px-2 py-1 rounded">
                  {tag._count?.assignments || 0} contactos
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => startEdit(tag)}
                  className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                  title="Editar"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  onClick={() => handleDelete(tag.id)}
                  className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  title="Eliminar"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-8 p-4 bg-blue-50 rounded-xl border border-blue-200">
        <h4 className="font-medium text-blue-900 mb-2">Como funciona el sistema de etapas</h4>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>1. Asigna etapas a tus contactos desde el panel de chat</li>
          <li>2. El agente AI recibira el contexto de la etapa en cada conversacion</li>
          <li>3. Usa la clasificacion automatica para detectar en que etapa esta cada cliente</li>
          <li>4. Las instrucciones especificas de cada etapa modifican el comportamiento del agente</li>
        </ul>
      </div>
    </div>
  );
}

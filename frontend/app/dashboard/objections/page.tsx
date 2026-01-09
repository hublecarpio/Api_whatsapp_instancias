'use client';

import { useState, useEffect } from 'react';
import { useBusinessStore } from '@/store/business';
import { objectionsApi } from '@/lib/api';

interface Objection {
  id: string;
  name: string;
  triggerPhrases: string[];
  responseScript: string;
  priority: number;
  category: string | null;
  isActive: boolean;
  createdAt: string;
}

const CATEGORIES = [
  { value: 'precio', label: 'Precio' },
  { value: 'tiempo', label: 'Tiempo' },
  { value: 'indecision', label: 'Indecision' },
  { value: 'competencia', label: 'Competencia' },
  { value: 'decision', label: 'Decision' },
  { value: 'logistica', label: 'Logistica' },
  { value: 'confianza', label: 'Confianza' },
  { value: 'otro', label: 'Otro' },
];

export default function ObjectionsPage() {
  const { currentBusiness } = useBusinessStore();
  const [objections, setObjections] = useState<Objection[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  
  const [showModal, setShowModal] = useState(false);
  const [editingObjection, setEditingObjection] = useState<Objection | null>(null);
  
  const [formData, setFormData] = useState({
    name: '',
    triggerPhrases: '',
    responseScript: '',
    priority: 0,
    category: 'otro',
  });

  useEffect(() => {
    if (currentBusiness?.id) {
      loadObjections();
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

  const loadObjections = async () => {
    try {
      setLoading(true);
      const response = await objectionsApi.list(currentBusiness!.id);
      setObjections(response.data);
    } catch (err: any) {
      setError('Error al cargar objeciones');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!formData.name.trim() || !formData.responseScript.trim()) {
      setError('Nombre y script de respuesta son requeridos');
      return;
    }

    try {
      setSaving(true);
      setError('');
      
      const triggerPhrases = formData.triggerPhrases
        .split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0);

      if (editingObjection) {
        await objectionsApi.update(currentBusiness!.id, editingObjection.id, {
          name: formData.name.trim(),
          triggerPhrases,
          responseScript: formData.responseScript.trim(),
          priority: formData.priority,
          category: formData.category,
        });
        setSuccess('Objecion actualizada');
      } else {
        await objectionsApi.create(currentBusiness!.id, {
          name: formData.name.trim(),
          triggerPhrases,
          responseScript: formData.responseScript.trim(),
          priority: formData.priority,
          category: formData.category,
        });
        setSuccess('Objecion creada');
      }

      setShowModal(false);
      resetForm();
      loadObjections();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al guardar objecion');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (objection: Objection) => {
    try {
      await objectionsApi.update(currentBusiness!.id, objection.id, {
        isActive: !objection.isActive,
      });
      loadObjections();
    } catch (err: any) {
      setError('Error al cambiar estado');
    }
  };

  const handleDelete = async (objectionId: string) => {
    if (!confirm('¿Eliminar esta objecion?')) return;
    
    try {
      await objectionsApi.delete(currentBusiness!.id, objectionId);
      setSuccess('Objecion eliminada');
      loadObjections();
    } catch (err: any) {
      setError('Error al eliminar objecion');
    }
  };

  const handleSeedDefaults = async () => {
    if (!confirm('¿Crear objeciones predeterminadas? Solo funciona si no hay objeciones configuradas.')) return;
    
    try {
      setSaving(true);
      const response = await objectionsApi.seedDefaults(currentBusiness!.id);
      setSuccess(`Creadas ${response.data.created} objeciones predeterminadas`);
      loadObjections();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al crear objeciones');
    } finally {
      setSaving(false);
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      triggerPhrases: '',
      responseScript: '',
      priority: 0,
      category: 'otro',
    });
    setEditingObjection(null);
  };

  const openEdit = (objection: Objection) => {
    setEditingObjection(objection);
    setFormData({
      name: objection.name,
      triggerPhrases: objection.triggerPhrases.join(', '),
      responseScript: objection.responseScript,
      priority: objection.priority,
      category: objection.category || 'otro',
    });
    setShowModal(true);
  };

  if (!currentBusiness) {
    return (
      <div className="p-6">
        <p className="text-gray-500">Selecciona un negocio primero</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Manejo de Objeciones</h1>
          <p className="text-gray-600 mt-1">
            Configura respuestas automaticas para objeciones comunes de clientes
          </p>
        </div>
        <div className="flex gap-2">
          {objections.length === 0 && (
            <button
              onClick={handleSeedDefaults}
              disabled={saving}
              className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
            >
              Crear Predeterminadas
            </button>
          )}
          <button
            onClick={() => {
              resetForm();
              setShowModal(true);
            }}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
          >
            + Nueva Objecion
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-100 text-red-700 rounded-lg">{error}</div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-100 text-green-700 rounded-lg">{success}</div>
      )}

      {loading ? (
        <div className="text-center py-8 text-gray-500">Cargando...</div>
      ) : objections.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg">
          <p className="text-gray-500 mb-4">No hay objeciones configuradas</p>
          <p className="text-sm text-gray-400">
            Las objeciones ayudan al agente IA a responder de forma efectiva cuando los clientes expresan dudas o resistencia
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {objections.map((objection) => (
            <div
              key={objection.id}
              className={`bg-white rounded-lg border p-4 ${!objection.isActive ? 'opacity-50' : ''}`}
            >
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="font-semibold text-gray-900">{objection.name}</h3>
                    {objection.category && (
                      <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                        {CATEGORIES.find(c => c.value === objection.category)?.label || objection.category}
                      </span>
                    )}
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-600 text-xs rounded">
                      Prioridad: {objection.priority}
                    </span>
                  </div>
                  
                  <div className="mb-2">
                    <span className="text-sm text-gray-500">Frases clave: </span>
                    <span className="text-sm text-gray-700">
                      {objection.triggerPhrases.join(', ') || 'Sin frases configuradas'}
                    </span>
                  </div>
                  
                  <div className="bg-gray-50 rounded p-3 text-sm text-gray-700">
                    <span className="text-gray-500 block mb-1">Respuesta:</span>
                    {objection.responseScript}
                  </div>
                </div>
                
                <div className="flex items-center gap-2 ml-4">
                  <button
                    onClick={() => handleToggle(objection)}
                    className={`w-12 h-6 rounded-full transition-colors ${
                      objection.isActive ? 'bg-green-500' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`block w-5 h-5 bg-white rounded-full shadow transform transition-transform ${
                        objection.isActive ? 'translate-x-6' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                  <button
                    onClick={() => openEdit(objection)}
                    className="p-2 text-gray-600 hover:text-blue-600"
                    title="Editar"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDelete(objection.id)}
                    className="p-2 text-gray-600 hover:text-red-600"
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

      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-4">
              {editingObjection ? 'Editar Objecion' : 'Nueva Objecion'}
            </h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Nombre *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2"
                  placeholder="Ej: Precio muy alto"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Categoria
                </label>
                <select
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat.value} value={cat.value}>{cat.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Frases Clave
                </label>
                <input
                  type="text"
                  value={formData.triggerPhrases}
                  onChange={(e) => setFormData({ ...formData, triggerPhrases: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2"
                  placeholder="muy caro, precio alto, fuera de presupuesto (separadas por comas)"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Cuando el cliente use estas palabras, el agente aplicara esta respuesta
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Script de Respuesta *
                </label>
                <textarea
                  value={formData.responseScript}
                  onChange={(e) => setFormData({ ...formData, responseScript: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 h-32"
                  placeholder="La respuesta que el agente usara cuando detecte esta objecion..."
                />
                <p className="text-xs text-gray-500 mt-1">
                  Usa [corchetes] para indicar que el agente debe personalizar esa parte
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Prioridad
                </label>
                <input
                  type="number"
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) || 0 })}
                  className="w-full border rounded-lg px-3 py-2"
                  min="0"
                  max="100"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Mayor prioridad = se aplica primero si hay multiples coincidencias
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowModal(false);
                  resetForm();
                }}
                className="px-4 py-2 text-gray-600 hover:text-gray-800"
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {saving ? 'Guardando...' : (editingObjection ? 'Actualizar' : 'Crear')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

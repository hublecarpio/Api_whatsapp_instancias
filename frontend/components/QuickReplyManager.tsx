'use client';

import { useState, useEffect } from 'react';
import { quickRepliesApi } from '@/lib/api';

interface QuickReply {
  id: string;
  shortcut: string;
  title: string;
  message: string;
  order: number;
}

interface QuickReplyManagerProps {
  businessId: string;
  onClose: () => void;
}

export default function QuickReplyManager({ businessId, onClose }: QuickReplyManagerProps) {
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [formData, setFormData] = useState({
    shortcut: '',
    title: '',
    message: ''
  });

  const fetchReplies = async () => {
    try {
      const res = await quickRepliesApi.list(businessId);
      setReplies(res.data);
    } catch (err) {
      console.error('Failed to fetch quick replies:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReplies();
  }, [businessId]);

  const handleCreate = async () => {
    if (!formData.shortcut.trim() || !formData.title.trim() || !formData.message.trim()) {
      setError('Todos los campos son requeridos');
      return;
    }
    
    setSaving(true);
    setError(null);
    try {
      await quickRepliesApi.create(businessId, {
        shortcut: formData.shortcut.toLowerCase().replace(/[^a-z0-9_-]/g, ''),
        title: formData.title,
        message: formData.message,
        order: replies.length
      });
      setFormData({ shortcut: '', title: '', message: '' });
      setShowNew(false);
      fetchReplies();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al crear');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingId) return;
    
    setSaving(true);
    setError(null);
    try {
      await quickRepliesApi.update(editingId, {
        shortcut: formData.shortcut.toLowerCase().replace(/[^a-z0-9_-]/g, ''),
        title: formData.title,
        message: formData.message
      });
      setEditingId(null);
      setFormData({ shortcut: '', title: '', message: '' });
      fetchReplies();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al actualizar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Eliminar esta respuesta rapida?')) return;
    
    try {
      await quickRepliesApi.delete(id);
      fetchReplies();
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  };

  const startEdit = (reply: QuickReply) => {
    setEditingId(reply.id);
    setFormData({
      shortcut: reply.shortcut,
      title: reply.title,
      message: reply.message
    });
    setShowNew(false);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setShowNew(false);
    setFormData({ shortcut: '', title: '', message: '' });
    setError(null);
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-dark-card rounded-xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-xl border border-dark-border">
        <div className="flex items-center justify-between p-4 border-b border-dark-border">
          <h2 className="text-lg font-semibold text-white">Respuestas Rapidas</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-6 h-6 border-2 border-neon-blue border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {replies.length === 0 && !showNew ? (
                <div className="text-center py-8">
                  <div className="text-4xl mb-3">⚡</div>
                  <p className="text-gray-400 mb-4">No hay respuestas rapidas</p>
                  <button
                    onClick={() => setShowNew(true)}
                    className="px-4 py-2 bg-neon-blue text-dark-bg rounded-lg font-medium hover:bg-neon-blue-light transition-colors"
                  >
                    Crear Primera
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {replies.map((reply) => (
                    <div 
                      key={reply.id}
                      className={`p-3 rounded-lg border transition-colors ${
                        editingId === reply.id 
                          ? 'border-neon-blue bg-neon-blue/10' 
                          : 'border-dark-border bg-dark-surface hover:border-gray-600'
                      }`}
                    >
                      {editingId === reply.id ? (
                        <div className="space-y-3">
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Atajo</label>
                              <div className="flex items-center">
                                <span className="text-neon-blue mr-1">/</span>
                                <input
                                  type="text"
                                  value={formData.shortcut}
                                  onChange={(e) => setFormData({ ...formData, shortcut: e.target.value })}
                                  placeholder="precio"
                                  className="flex-1 px-2 py-1.5 bg-dark-bg border border-dark-border rounded text-white text-sm focus:outline-none focus:border-neon-blue"
                                />
                              </div>
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Titulo</label>
                              <input
                                type="text"
                                value={formData.title}
                                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                                placeholder="Precios"
                                className="w-full px-2 py-1.5 bg-dark-bg border border-dark-border rounded text-white text-sm focus:outline-none focus:border-neon-blue"
                              />
                            </div>
                          </div>
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Mensaje</label>
                            <textarea
                              value={formData.message}
                              onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                              placeholder="Nuestros precios son..."
                              rows={3}
                              className="w-full px-2 py-1.5 bg-dark-bg border border-dark-border rounded text-white text-sm focus:outline-none focus:border-neon-blue resize-none"
                            />
                          </div>
                          {error && <p className="text-accent-error text-xs">{error}</p>}
                          <div className="flex gap-2 justify-end">
                            <button
                              onClick={cancelEdit}
                              className="px-3 py-1.5 text-gray-400 hover:text-white text-sm transition-colors"
                            >
                              Cancelar
                            </button>
                            <button
                              onClick={handleUpdate}
                              disabled={saving}
                              className="px-3 py-1.5 bg-neon-blue text-dark-bg rounded text-sm font-medium hover:bg-neon-blue-light disabled:opacity-50 transition-colors"
                            >
                              {saving ? 'Guardando...' : 'Guardar'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-neon-blue font-mono text-sm">/{reply.shortcut}</span>
                              <span className="text-white font-medium text-sm">{reply.title}</span>
                            </div>
                            <p className="text-gray-400 text-xs line-clamp-2">{reply.message}</p>
                          </div>
                          <div className="flex gap-1 flex-shrink-0">
                            <button
                              onClick={() => startEdit(reply)}
                              className="p-1.5 text-gray-400 hover:text-neon-blue transition-colors"
                              title="Editar"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => handleDelete(reply.id)}
                              className="p-1.5 text-gray-400 hover:text-accent-error transition-colors"
                              title="Eliminar"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                  {showNew && (
                    <div className="p-3 rounded-lg border border-neon-blue bg-neon-blue/10">
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Atajo</label>
                            <div className="flex items-center">
                              <span className="text-neon-blue mr-1">/</span>
                              <input
                                type="text"
                                value={formData.shortcut}
                                onChange={(e) => setFormData({ ...formData, shortcut: e.target.value })}
                                placeholder="precio"
                                className="flex-1 px-2 py-1.5 bg-dark-bg border border-dark-border rounded text-white text-sm focus:outline-none focus:border-neon-blue"
                                autoFocus
                              />
                            </div>
                          </div>
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Titulo</label>
                            <input
                              type="text"
                              value={formData.title}
                              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                              placeholder="Lista de Precios"
                              className="w-full px-2 py-1.5 bg-dark-bg border border-dark-border rounded text-white text-sm focus:outline-none focus:border-neon-blue"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-400 mb-1">Mensaje</label>
                          <textarea
                            value={formData.message}
                            onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                            placeholder="Nuestros precios son..."
                            rows={3}
                            className="w-full px-2 py-1.5 bg-dark-bg border border-dark-border rounded text-white text-sm focus:outline-none focus:border-neon-blue resize-none"
                          />
                        </div>
                        {error && <p className="text-accent-error text-xs">{error}</p>}
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={cancelEdit}
                            className="px-3 py-1.5 text-gray-400 hover:text-white text-sm transition-colors"
                          >
                            Cancelar
                          </button>
                          <button
                            onClick={handleCreate}
                            disabled={saving}
                            className="px-3 py-1.5 bg-neon-blue text-dark-bg rounded text-sm font-medium hover:bg-neon-blue-light disabled:opacity-50 transition-colors"
                          >
                            {saving ? 'Creando...' : 'Crear'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {replies.length > 0 && !showNew && !editingId && (
          <div className="p-4 border-t border-dark-border">
            <button
              onClick={() => {
                setShowNew(true);
                setFormData({ shortcut: '', title: '', message: '' });
              }}
              className="w-full py-2 bg-dark-surface border border-dark-border rounded-lg text-white hover:border-neon-blue transition-colors flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Nueva Respuesta
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

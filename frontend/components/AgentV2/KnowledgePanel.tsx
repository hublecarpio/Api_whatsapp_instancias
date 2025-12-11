'use client';

import { useState, useEffect } from 'react';
import { knowledgeApi } from '@/lib/api';

interface KnowledgeDocument {
  id: string;
  title: string;
  type: string;
  enabled: boolean;
  createdAt: string;
  metadata?: {
    wordCount?: number;
    chunkCount?: number;
    hasEmbedding?: boolean;
  };
}

interface KnowledgePanelProps {
  businessId: string;
}

const DOC_TYPES = [
  { value: 'TEXT', label: 'Texto General' },
  { value: 'FAQ', label: 'Preguntas Frecuentes' },
  { value: 'POLICY', label: 'Politicas' },
  { value: 'GUIDE', label: 'Guia/Manual' },
  { value: 'OTHER', label: 'Otro' }
];

export default function KnowledgePanel({ businessId }: KnowledgePanelProps) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingDoc, setEditingDoc] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    title: '',
    content: '',
    type: 'TEXT'
  });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    loadDocuments();
  }, [businessId]);

  const loadDocuments = async () => {
    setLoading(true);
    try {
      const res = await knowledgeApi.list(businessId);
      setDocuments(res.data.documents || []);
    } catch (err) {
      console.error('Error loading documents:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!formData.title.trim() || !formData.content.trim()) {
      setError('Titulo y contenido son requeridos');
      return;
    }

    setLoading(true);
    setError('');

    try {
      if (editingDoc) {
        await knowledgeApi.update(businessId, editingDoc, formData);
        setSuccess('Documento actualizado correctamente');
      } else {
        await knowledgeApi.create(businessId, formData);
        setSuccess('Documento creado correctamente');
      }
      setShowForm(false);
      setEditingDoc(null);
      setFormData({ title: '', content: '', type: 'TEXT' });
      loadDocuments();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al guardar documento');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = async (docId: string) => {
    setLoading(true);
    try {
      const res = await knowledgeApi.get(businessId, docId);
      const doc = res.data.document;
      setFormData({
        title: doc.title,
        content: doc.content,
        type: doc.type
      });
      setEditingDoc(docId);
      setShowForm(true);
    } catch (err) {
      setError('Error al cargar documento');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (docId: string) => {
    if (!confirm('Estas seguro de eliminar este documento?')) return;

    try {
      await knowledgeApi.delete(businessId, docId);
      setSuccess('Documento eliminado');
      loadDocuments();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al eliminar');
    }
  };

  const handleToggle = async (docId: string, enabled: boolean) => {
    try {
      await knowledgeApi.update(businessId, docId, { enabled: !enabled });
      loadDocuments();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al actualizar');
    }
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingDoc(null);
    setFormData({ title: '', content: '', type: 'TEXT' });
    setError('');
  };

  return (
    <div className="space-y-4">
      {success && (
        <div className="bg-accent-success/10 border border-accent-success/20 text-accent-success px-4 py-3 rounded-lg">
          {success}
        </div>
      )}
      {error && (
        <div className="bg-accent-error/10 border border-accent-error/20 text-accent-error px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Base de Conocimiento</h2>
            <p className="text-sm text-gray-400">
              Sube documentos, FAQs, politicas y guias para que el agente pueda responder consultas
            </p>
          </div>
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              className="px-4 py-2 bg-neon-purple text-white rounded-lg hover:bg-purple-600 transition-colors"
            >
              + Agregar Documento
            </button>
          )}
        </div>

        {showForm && (
          <div className="bg-dark-hover p-4 rounded-lg mb-4">
            <h3 className="text-white font-medium mb-4">
              {editingDoc ? 'Editar Documento' : 'Nuevo Documento'}
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Titulo</label>
                <input
                  type="text"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  className="w-full px-3 py-2 bg-dark-bg border border-gray-700 rounded-lg text-white focus:outline-none focus:border-neon-purple"
                  placeholder="Ej: Politica de Envios"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Tipo</label>
                <select
                  value={formData.type}
                  onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                  className="w-full px-3 py-2 bg-dark-bg border border-gray-700 rounded-lg text-white focus:outline-none focus:border-neon-purple"
                >
                  {DOC_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Contenido</label>
                <textarea
                  value={formData.content}
                  onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                  rows={10}
                  className="w-full px-3 py-2 bg-dark-bg border border-gray-700 rounded-lg text-white focus:outline-none focus:border-neon-purple resize-none"
                  placeholder="Escribe o pega aqui el contenido del documento..."
                />
                <p className="text-xs text-gray-500 mt-1">
                  {formData.content.split(/\s+/).filter(Boolean).length} palabras
                </p>
              </div>

              <div className="flex gap-2 justify-end">
                <button
                  onClick={handleCancel}
                  className="px-4 py-2 bg-gray-700 text-gray-300 rounded-lg hover:bg-gray-600 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={loading}
                  className="px-4 py-2 bg-neon-purple text-white rounded-lg hover:bg-purple-600 transition-colors disabled:opacity-50"
                >
                  {loading ? 'Guardando...' : editingDoc ? 'Actualizar' : 'Crear'}
                </button>
              </div>
            </div>
          </div>
        )}

        {loading && !showForm ? (
          <div className="text-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-neon-purple mx-auto"></div>
          </div>
        ) : documents.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p>No hay documentos en la base de conocimiento</p>
            <p className="text-sm mt-1">Agrega documentos para que el agente pueda responder consultas</p>
          </div>
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className={`flex items-center justify-between p-3 rounded-lg border ${
                  doc.enabled
                    ? 'bg-dark-hover border-gray-700'
                    : 'bg-dark-bg/50 border-gray-800 opacity-60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${doc.enabled ? 'bg-accent-success' : 'bg-gray-500'}`} />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-white font-medium">{doc.title}</span>
                      <span className="text-xs px-2 py-0.5 bg-neon-purple/20 text-neon-purple rounded-full">
                        {DOC_TYPES.find((t) => t.value === doc.type)?.label || doc.type}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 flex gap-3 mt-0.5">
                      <span>{doc.metadata?.wordCount || 0} palabras</span>
                      <span>{doc.metadata?.hasEmbedding ? 'Con embeddings' : 'Sin embeddings'}</span>
                      <span>{new Date(doc.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleToggle(doc.id, doc.enabled)}
                    className={`p-2 rounded-lg transition-colors ${
                      doc.enabled
                        ? 'text-accent-success hover:bg-accent-success/10'
                        : 'text-gray-500 hover:bg-gray-700'
                    }`}
                    title={doc.enabled ? 'Desactivar' : 'Activar'}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      {doc.enabled ? (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      ) : (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                      )}
                    </svg>
                  </button>
                  <button
                    onClick={() => handleEdit(doc.id)}
                    className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
                    title="Editar"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDelete(doc.id)}
                    className="p-2 text-gray-400 hover:text-accent-error hover:bg-accent-error/10 rounded-lg transition-colors"
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
      </div>
    </div>
  );
}

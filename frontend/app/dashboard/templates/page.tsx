'use client';

import { useState, useEffect } from 'react';
import { useBusinessStore } from '@/store/business';
import { templatesApi, waApi } from '@/lib/api';

interface Template {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  headerType?: string;
  bodyText?: string;
  footerText?: string;
  buttons?: any[];
  lastSynced: string;
  createdAt: string;
}

export default function TemplatesPage() {
  const { currentBusiness } = useBusinessStore();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [hasMetaInstance, setHasMetaInstance] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  
  const [newTemplate, setNewTemplate] = useState({
    name: '',
    language: 'es',
    category: 'UTILITY',
    headerType: 'NONE',
    headerText: '',
    bodyText: '',
    footerText: '',
    buttons: [] as Array<{ type: string; text: string; url?: string }>
  });

  useEffect(() => {
    if (currentBusiness) {
      checkMetaInstance();
      fetchTemplates();
    }
  }, [currentBusiness]);

  const checkMetaInstance = async () => {
    try {
      const response = await waApi.status(currentBusiness!.id);
      setHasMetaInstance(response.data.provider === 'META_CLOUD');
    } catch {
      setHasMetaInstance(false);
    }
  };

  const fetchTemplates = async () => {
    try {
      setLoading(true);
      const response = await templatesApi.list(currentBusiness!.id);
      setTemplates(response.data);
      setError('');
    } catch (err: any) {
      if (err.response?.status === 404) {
        setError('');
      } else {
        setError(err.response?.data?.error || 'Error loading templates');
      }
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    try {
      setSyncing(true);
      setError('');
      const response = await templatesApi.sync(currentBusiness!.id);
      setSuccess(`Sincronizados ${response.data.synced} templates desde Meta`);
      await fetchTemplates();
      setTimeout(() => setSuccess(''), 5000);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error syncing templates');
    } finally {
      setSyncing(false);
    }
  };

  const handleCreate = async () => {
    if (!newTemplate.name || !newTemplate.bodyText) {
      setError('El nombre y el texto del cuerpo son obligatorios');
      return;
    }

    try {
      setCreating(true);
      setError('');
      await templatesApi.create(currentBusiness!.id, {
        name: newTemplate.name,
        language: newTemplate.language,
        category: newTemplate.category,
        headerType: newTemplate.headerType !== 'NONE' ? newTemplate.headerType : undefined,
        headerText: newTemplate.headerType === 'TEXT' ? newTemplate.headerText : undefined,
        bodyText: newTemplate.bodyText,
        footerText: newTemplate.footerText || undefined,
        buttons: newTemplate.buttons.length > 0 ? newTemplate.buttons : undefined
      });
      setSuccess('Template creado y enviado para aprobacion');
      setShowCreateModal(false);
      setNewTemplate({
        name: '',
        language: 'es',
        category: 'UTILITY',
        headerType: 'NONE',
        headerText: '',
        bodyText: '',
        footerText: '',
        buttons: []
      });
      await fetchTemplates();
      setTimeout(() => setSuccess(''), 5000);
    } catch (err: any) {
      setError(err.response?.data?.details || err.response?.data?.error || 'Error creating template');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (templateId: string) => {
    if (!confirm('Eliminar este template? Esta accion no se puede deshacer.')) return;

    try {
      setError('');
      await templatesApi.delete(currentBusiness!.id, templateId);
      setSuccess('Template eliminado');
      await fetchTemplates();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error deleting template');
    }
  };

  const addButton = () => {
    if (newTemplate.buttons.length >= 3) return;
    setNewTemplate(prev => ({
      ...prev,
      buttons: [...prev.buttons, { type: 'QUICK_REPLY', text: '' }]
    }));
  };

  const removeButton = (index: number) => {
    setNewTemplate(prev => ({
      ...prev,
      buttons: prev.buttons.filter((_, i) => i !== index)
    }));
  };

  const updateButton = (index: number, field: string, value: string) => {
    setNewTemplate(prev => ({
      ...prev,
      buttons: prev.buttons.map((btn, i) => 
        i === index ? { ...btn, [field]: value } : btn
      )
    }));
  };

  const getStatusBadge = (status: string) => {
    const badges: Record<string, { bg: string; text: string }> = {
      'APPROVED': { bg: 'bg-accent-success', text: 'Aprobado' },
      'PENDING': { bg: 'bg-accent-warning', text: 'Pendiente' },
      'REJECTED': { bg: 'bg-accent-error', text: 'Rechazado' },
      'DISABLED': { bg: 'bg-gray-500', text: 'Deshabilitado' }
    };
    const badge = badges[status] || { bg: 'bg-gray-500', text: status };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium text-white ${badge.bg}`}>
        {badge.text}
      </span>
    );
  };

  const getCategoryBadge = (category: string) => {
    const categories: Record<string, string> = {
      'UTILITY': 'Utilidad',
      'MARKETING': 'Marketing',
      'AUTHENTICATION': 'Autenticacion'
    };
    return categories[category] || category;
  };

  if (!currentBusiness) {
    return (
      <div className="card text-center py-8">
        <p className="text-gray-400">Primero debes seleccionar una empresa.</p>
      </div>
    );
  }

  if (!hasMetaInstance && !loading) {
    return (
      <div className="card text-center py-8">
        <div className="text-4xl mb-3">📱</div>
        <h2 className="text-lg font-semibold text-white mb-2">Meta Cloud API requerida</h2>
        <p className="text-gray-400 mb-4">
          Los templates solo estan disponibles cuando usas Meta Cloud API.
          <br />
          Conecta tu cuenta de Meta Business para usar esta funcion.
        </p>
        <a href="/dashboard/whatsapp" className="btn btn-primary">
          Ir a WhatsApp
        </a>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white">Templates de WhatsApp</h1>
          <p className="text-sm text-gray-400 mt-1">
            Plantillas aprobadas por Meta para mensajes iniciales y seguimientos
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="btn btn-secondary"
          >
            {syncing ? 'Sincronizando...' : 'Sincronizar desde Meta'}
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="btn btn-primary"
          >
            + Crear Template
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-accent-error/10 border border-accent-error/20 text-accent-error px-4 py-3 rounded-lg mb-4 flex justify-between items-center">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-accent-error/70 hover:text-accent-error ml-2">✕</button>
        </div>
      )}

      {success && (
        <div className="bg-accent-success/10 border border-accent-success/20 text-accent-success px-4 py-3 rounded-lg mb-4 flex justify-between items-center">
          <span>{success}</span>
          <button onClick={() => setSuccess('')} className="text-accent-success/70 hover:text-accent-success ml-2">✕</button>
        </div>
      )}

      <div className="bg-neon-blue/10 border border-neon-blue/30 text-neon-blue px-4 py-3 rounded-lg mb-4 text-sm">
        <strong>Importante:</strong> Los templates son obligatorios para enviar el primer mensaje a un cliente 
        o cuando han pasado mas de 24 horas desde su ultima respuesta. Meta debe aprobar cada template.
      </div>

      {loading ? (
        <div className="card text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-neon-blue mx-auto"></div>
          <p className="mt-3 text-gray-400">Cargando templates...</p>
        </div>
      ) : templates.length === 0 ? (
        <div className="card text-center py-8">
          <div className="text-4xl mb-3">📄</div>
          <h2 className="text-lg font-semibold text-white mb-2">No hay templates</h2>
          <p className="text-gray-400 mb-4">
            Sincroniza desde Meta o crea tu primer template
          </p>
          <div className="flex justify-center gap-2">
            <button onClick={handleSync} disabled={syncing} className="btn btn-secondary">
              Sincronizar
            </button>
            <button onClick={() => setShowCreateModal(true)} className="btn btn-primary">
              + Crear Template
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4">
          {templates.map(template => (
            <div key={template.id} className="card">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <h3 className="font-semibold text-white">{template.name}</h3>
                    {getStatusBadge(template.status)}
                    <span className="text-xs text-gray-500 bg-dark-hover px-2 py-0.5 rounded">
                      {getCategoryBadge(template.category)}
                    </span>
                    <span className="text-xs text-gray-500">
                      {template.language.toUpperCase()}
                    </span>
                  </div>
                  
                  {template.bodyText && (
                    <p className="text-gray-300 text-sm mb-2 bg-dark-hover p-2 rounded">
                      {template.bodyText}
                    </p>
                  )}

                  {template.footerText && (
                    <p className="text-gray-500 text-xs italic">
                      {template.footerText}
                    </p>
                  )}

                  {template.buttons && template.buttons.length > 0 && (
                    <div className="flex gap-2 mt-2">
                      {template.buttons.map((btn: any, i: number) => (
                        <span key={i} className="text-xs bg-neon-blue/20 text-neon-blue px-2 py-1 rounded">
                          {btn.type === 'URL' ? '🔗' : '↩️'} {btn.text}
                        </span>
                      ))}
                    </div>
                  )}

                  <p className="text-xs text-gray-500 mt-2">
                    Ultima sincronizacion: {new Date(template.lastSynced).toLocaleString()}
                  </p>
                </div>

                <button
                  onClick={() => handleDelete(template.id)}
                  className="text-accent-error hover:text-red-400 p-2"
                  title="Eliminar"
                >
                  🗑️
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-white mb-4">Crear Template</h2>
            
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    Nombre <span className="text-accent-error">*</span>
                  </label>
                  <input
                    type="text"
                    value={newTemplate.name}
                    onChange={e => setNewTemplate(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="mi_template"
                    className="input"
                  />
                  <p className="text-xs text-gray-500 mt-1">Solo letras, numeros y guiones bajos</p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">Idioma</label>
                    <select
                      value={newTemplate.language}
                      onChange={e => setNewTemplate(prev => ({ ...prev, language: e.target.value }))}
                      className="input"
                    >
                      <option value="es">Español</option>
                      <option value="es_MX">Español (MX)</option>
                      <option value="es_AR">Español (AR)</option>
                      <option value="en">English</option>
                      <option value="pt_BR">Portugues (BR)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">Categoria</label>
                    <select
                      value={newTemplate.category}
                      onChange={e => setNewTemplate(prev => ({ ...prev, category: e.target.value }))}
                      className="input"
                    >
                      <option value="UTILITY">Utilidad</option>
                      <option value="MARKETING">Marketing</option>
                      <option value="AUTHENTICATION">Autenticacion</option>
                    </select>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Encabezado</label>
                <select
                  value={newTemplate.headerType}
                  onChange={e => setNewTemplate(prev => ({ ...prev, headerType: e.target.value }))}
                  className="input mb-2"
                >
                  <option value="NONE">Sin encabezado</option>
                  <option value="TEXT">Texto</option>
                  <option value="IMAGE">Imagen</option>
                  <option value="VIDEO">Video</option>
                  <option value="DOCUMENT">Documento</option>
                </select>
                {newTemplate.headerType === 'TEXT' && (
                  <input
                    type="text"
                    value={newTemplate.headerText}
                    onChange={e => setNewTemplate(prev => ({ ...prev, headerText: e.target.value }))}
                    placeholder="Texto del encabezado"
                    className="input"
                  />
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Cuerpo del mensaje <span className="text-accent-error">*</span>
                </label>
                <textarea
                  value={newTemplate.bodyText}
                  onChange={e => setNewTemplate(prev => ({ ...prev, bodyText: e.target.value }))}
                  placeholder="Hola {{1}}, tu pedido #{{2}} esta listo para recoger."
                  className="input resize-none"
                  rows={4}
                />
                <p className="text-xs text-gray-500 mt-1">
                  Usa {"{{1}}"}, {"{{2}}"}, etc. para variables dinamicas
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Pie de pagina</label>
                <input
                  type="text"
                  value={newTemplate.footerText}
                  onChange={e => setNewTemplate(prev => ({ ...prev, footerText: e.target.value }))}
                  placeholder="Responde STOP para dejar de recibir mensajes"
                  className="input"
                  maxLength={60}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-300">Botones (max. 3)</label>
                  {newTemplate.buttons.length < 3 && (
                    <button
                      type="button"
                      onClick={addButton}
                      className="text-sm text-neon-blue hover:text-cyan-400"
                    >
                      + Agregar boton
                    </button>
                  )}
                </div>
                {newTemplate.buttons.map((btn, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <select
                      value={btn.type}
                      onChange={e => updateButton(i, 'type', e.target.value)}
                      className="input w-32"
                    >
                      <option value="QUICK_REPLY">Respuesta</option>
                      <option value="URL">URL</option>
                      <option value="PHONE_NUMBER">Telefono</option>
                    </select>
                    <input
                      type="text"
                      value={btn.text}
                      onChange={e => updateButton(i, 'text', e.target.value)}
                      placeholder="Texto del boton"
                      className="input flex-1"
                      maxLength={25}
                    />
                    {btn.type === 'URL' && (
                      <input
                        type="text"
                        value={btn.url || ''}
                        onChange={e => updateButton(i, 'url', e.target.value)}
                        placeholder="https://..."
                        className="input flex-1"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => removeButton(i)}
                      className="text-accent-error hover:text-red-400 px-2"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowCreateModal(false)}
                className="flex-1 btn btn-secondary"
              >
                Cancelar
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex-1 btn btn-primary"
              >
                {creating ? 'Creando...' : 'Crear Template'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

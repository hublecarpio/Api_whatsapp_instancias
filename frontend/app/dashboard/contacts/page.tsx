'use client';

import { useEffect, useState } from 'react';
import { useBusinessStore } from '@/store/business';
import axios from 'axios';

interface ContactStats {
  ordersCount: number;
  totalSpent: number;
  messagesCount: number;
  lastMessageAt: string | null;
}

interface Contact {
  id: string;
  phone: string;
  name: string | null;
  email?: string | null;
  botDisabled: boolean;
  notes: string | null;
  tags?: string[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  instance?: { id: string; name: string; provider: string } | null;
  stats?: ContactStats;
  extractedData?: Record<string, string | null>;
}

interface ContactDetail extends Contact {
  orders?: any[];
  appointments?: any[];
  instancesUsed?: { id: string; name: string; provider: string }[];
  timeline?: { type: string; id: string; date: string; data: any }[];
  metadata?: Record<string, any>;
}

interface EditForm {
  name: string;
  email: string;
  notes: string;
  tags: string[];
  extractedData: { key: string; value: string }[];
}

export default function ContactsPage() {
  const { currentBusiness } = useBusinessStore();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ total: 0, pages: 1 });
  const [expandedPhone, setExpandedPhone] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<ContactDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditForm>({ name: '', email: '', notes: '', tags: [], extractedData: [] });
  const [saving, setSaving] = useState(false);
  const [newFieldKey, setNewFieldKey] = useState('');
  const [newTag, setNewTag] = useState('');

  const API_URL = process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:3001';

  const getAuthHeader = () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    return { Authorization: `Bearer ${token}` };
  };

  const loadContacts = async (pageNum = 1, search = '') => {
    if (!currentBusiness?.id) return;
    
    try {
      setLoading(true);
      const params = new URLSearchParams();
      params.set('page', pageNum.toString());
      params.set('limit', '30');
      params.set('businessId', currentBusiness.id);
      if (search) params.set('search', search);
      
      const response = await axios.get(`${API_URL}/contacts?${params}`, { headers: getAuthHeader() });
      setContacts(response.data.contacts);
      setPagination(response.data.pagination);
    } catch (error) {
      console.error('Error loading contacts:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadContactDetail = async (phone: string) => {
    if (!currentBusiness?.id) return;
    
    try {
      setLoadingDetail(true);
      const params = new URLSearchParams();
      params.set('businessId', currentBusiness.id);
      
      const response = await axios.get(
        `${API_URL}/contacts/${encodeURIComponent(phone)}?${params}`,
        { headers: getAuthHeader() }
      );
      setExpandedDetail(response.data);
      
      const data = response.data;
      const extractedDataArray = data.extractedData 
        ? Object.entries(data.extractedData).map(([key, value]) => ({ key, value: String(value || '') }))
        : [];
      setEditForm({
        name: data.name || '',
        email: data.email || '',
        notes: data.notes || '',
        tags: data.tags || [],
        extractedData: extractedDataArray
      });
    } catch (error) {
      console.error('Error loading contact detail:', error);
    } finally {
      setLoadingDetail(false);
    }
  };

  const toggleExpand = async (phone: string) => {
    if (expandedPhone === phone) {
      setExpandedPhone(null);
      setExpandedDetail(null);
      setIsEditing(false);
    } else {
      setExpandedPhone(phone);
      setIsEditing(false);
      await loadContactDetail(phone);
    }
  };

  const saveContact = async () => {
    if (!currentBusiness?.id || !expandedPhone) return;
    
    try {
      setSaving(true);
      const extractedDataObj: Record<string, string> = {};
      editForm.extractedData.forEach(({ key, value }) => {
        if (key.trim()) {
          extractedDataObj[key.trim()] = value;
        }
      });

      await axios.put(
        `${API_URL}/contacts/${encodeURIComponent(expandedPhone)}`,
        {
          businessId: currentBusiness.id,
          name: editForm.name || null,
          email: editForm.email || null,
          notes: editForm.notes || null,
          tags: editForm.tags,
          extractedData: extractedDataObj
        },
        { headers: getAuthHeader() }
      );

      await loadContactDetail(expandedPhone);
      await loadContacts(page, searchQuery);
      setIsEditing(false);
    } catch (error) {
      console.error('Error saving contact:', error);
      alert('Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const addMetadataField = () => {
    if (!newFieldKey.trim()) return;
    if (editForm.extractedData.some(f => f.key.toLowerCase() === newFieldKey.toLowerCase())) {
      alert('Este campo ya existe');
      return;
    }
    setEditForm(prev => ({
      ...prev,
      extractedData: [...prev.extractedData, { key: newFieldKey.trim(), value: '' }]
    }));
    setNewFieldKey('');
  };

  const removeMetadataField = (index: number) => {
    setEditForm(prev => ({
      ...prev,
      extractedData: prev.extractedData.filter((_, i) => i !== index)
    }));
  };

  const updateMetadataValue = (index: number, value: string) => {
    setEditForm(prev => ({
      ...prev,
      extractedData: prev.extractedData.map((item, i) => 
        i === index ? { ...item, value } : item
      )
    }));
  };

  const addTag = () => {
    if (!newTag.trim()) return;
    const tag = newTag.trim().toLowerCase();
    if (editForm.tags.includes(tag)) {
      alert('Esta etiqueta ya existe');
      return;
    }
    setEditForm(prev => ({
      ...prev,
      tags: [...prev.tags, tag]
    }));
    setNewTag('');
  };

  const removeTag = (tagToRemove: string) => {
    setEditForm(prev => ({
      ...prev,
      tags: prev.tags.filter(t => t !== tagToRemove)
    }));
  };

  const exportCSV = async () => {
    if (!currentBusiness?.id) return;
    
    try {
      setExporting(true);
      const params = new URLSearchParams();
      params.set('businessId', currentBusiness.id);
      
      const response = await axios.get(
        `${API_URL}/contacts/export/csv?${params}`,
        { headers: getAuthHeader(), responseType: 'blob' }
      );
      
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `contactos_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      console.error('Error exporting CSV:', error);
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    loadContacts(page, searchQuery);
  }, [currentBusiness?.id, page]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      loadContacts(1, searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('es-PE', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  };

  const formatPhone = (phone: string) => {
    if (phone.length > 10) {
      return `+${phone.slice(0, 2)} ${phone.slice(2, 5)} ${phone.slice(5, 8)} ${phone.slice(8)}`;
    }
    return phone;
  };

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6 gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white">Contactos</h1>
          <p className="text-gray-400 text-sm mt-1">
            {pagination.total} contactos en total
          </p>
        </div>
        <button
          onClick={exportCSV}
          disabled={exporting}
          className="btn btn-secondary"
        >
          {exporting ? 'Exportando...' : 'Exportar CSV'}
        </button>
      </div>

      <div className="mb-6">
        <input
          type="text"
          placeholder="Buscar por nombre o telefono..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="input w-full sm:w-96"
        />
      </div>

      {loading ? (
        <div className="card">
          <div className="animate-pulse space-y-4">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-16 bg-dark-surface rounded" />
            ))}
          </div>
        </div>
      ) : contacts.length === 0 ? (
        <div className="card text-center py-12">
          <div className="text-4xl mb-4">👥</div>
          <p className="text-gray-400">No hay contactos</p>
          <p className="text-gray-500 text-sm mt-1">
            Los contactos apareceran cuando recibas mensajes de WhatsApp
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {contacts.map((contact) => (
            <div key={contact.id} className="card overflow-hidden">
              <div
                onClick={() => toggleExpand(contact.phone)}
                className="flex items-center justify-between cursor-pointer hover:bg-dark-hover/50 -m-4 p-4 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-neon-blue/20 flex items-center justify-center text-lg flex-shrink-0">
                    {contact.name ? contact.name.charAt(0).toUpperCase() : '👤'}
                  </div>
                  <div className="min-w-0">
                    <p className="text-white font-medium truncate">
                      {contact.name || formatPhone(contact.phone)}
                    </p>
                    <p className="text-gray-400 text-sm">{formatPhone(contact.phone)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right hidden sm:block">
                    <div className="flex items-center gap-2 text-xs">
                      {(contact.stats?.ordersCount || 0) > 0 && (
                        <span className="bg-green-500/20 text-green-400 px-2 py-0.5 rounded">
                          {contact.stats?.ordersCount} pedidos
                        </span>
                      )}
                      {(contact.stats?.messagesCount || 0) > 0 && (
                        <span className="bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">
                          {contact.stats?.messagesCount} msgs
                        </span>
                      )}
                    </div>
                    <p className="text-gray-500 text-xs mt-1">
                      {formatDate(contact.updatedAt)}
                    </p>
                  </div>
                  <svg 
                    className={`w-5 h-5 text-gray-400 transition-transform ${expandedPhone === contact.phone ? 'rotate-180' : ''}`}
                    fill="none" 
                    viewBox="0 0 24 24" 
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>

              {expandedPhone === contact.phone && (
                <div className="mt-4 pt-4 border-t border-dark-border">
                  {loadingDetail ? (
                    <div className="animate-pulse space-y-4">
                      <div className="h-24 bg-dark-surface rounded" />
                      <div className="h-32 bg-dark-surface rounded" />
                    </div>
                  ) : expandedDetail ? (
                    <div className="space-y-6">
                      <div className="grid grid-cols-3 gap-3">
                        <div className="bg-dark-surface rounded-lg p-3 text-center">
                          <p className="text-2xl font-bold text-white">{expandedDetail.stats?.ordersCount || 0}</p>
                          <p className="text-xs text-gray-400">Pedidos</p>
                        </div>
                        <div className="bg-dark-surface rounded-lg p-3 text-center">
                          <p className="text-2xl font-bold text-green-400">
                            S/.{(expandedDetail.stats?.totalSpent || 0).toFixed(0)}
                          </p>
                          <p className="text-xs text-gray-400">Total gastado</p>
                        </div>
                        <div className="bg-dark-surface rounded-lg p-3 text-center">
                          <p className="text-2xl font-bold text-blue-400">{expandedDetail.stats?.messagesCount || 0}</p>
                          <p className="text-xs text-gray-400">Mensajes</p>
                        </div>
                      </div>

                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-medium text-white">Informacion del contacto</h3>
                        {!isEditing ? (
                          <button
                            onClick={() => setIsEditing(true)}
                            className="text-sm text-neon-blue hover:text-neon-blue-light"
                          >
                            Editar
                          </button>
                        ) : (
                          <div className="flex gap-2">
                            <button
                              onClick={() => setIsEditing(false)}
                              className="text-sm text-gray-400 hover:text-white"
                            >
                              Cancelar
                            </button>
                            <button
                              onClick={saveContact}
                              disabled={saving}
                              className="text-sm text-neon-blue hover:text-neon-blue-light"
                            >
                              {saving ? 'Guardando...' : 'Guardar'}
                            </button>
                          </div>
                        )}
                      </div>

                      {isEditing ? (
                        <div className="space-y-4">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Nombre</label>
                              <input
                                type="text"
                                value={editForm.name}
                                onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))}
                                className="input w-full"
                                placeholder="Nombre del contacto"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Email</label>
                              <input
                                type="email"
                                value={editForm.email}
                                onChange={(e) => setEditForm(prev => ({ ...prev, email: e.target.value }))}
                                className="input w-full"
                                placeholder="correo@ejemplo.com"
                              />
                            </div>
                          </div>
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Notas</label>
                            <textarea
                              value={editForm.notes}
                              onChange={(e) => setEditForm(prev => ({ ...prev, notes: e.target.value }))}
                              className="input w-full h-20 resize-none"
                              placeholder="Notas sobre este contacto..."
                            />
                          </div>

                          <div>
                            <label className="block text-xs text-gray-400 mb-2">Etiquetas</label>
                            {editForm.tags.length > 0 && (
                              <div className="flex flex-wrap gap-2 mb-2">
                                {editForm.tags.map(tag => (
                                  <span 
                                    key={tag} 
                                    className="text-xs bg-neon-blue/20 text-neon-blue px-2 py-1 rounded-full flex items-center gap-1"
                                  >
                                    {tag}
                                    <button
                                      onClick={() => removeTag(tag)}
                                      className="hover:text-red-400"
                                    >
                                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                      </svg>
                                    </button>
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={newTag}
                                onChange={(e) => setNewTag(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
                                className="input flex-1"
                                placeholder="Nueva etiqueta..."
                              />
                              <button
                                onClick={addTag}
                                disabled={!newTag.trim()}
                                className="btn btn-secondary text-sm"
                              >
                                Agregar
                              </button>
                            </div>
                          </div>

                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <label className="block text-xs text-gray-400">Datos personalizados</label>
                            </div>
                            
                            {editForm.extractedData.length > 0 && (
                              <div className="space-y-2 mb-3">
                                {editForm.extractedData.map((field, idx) => (
                                  <div key={idx} className="flex items-center gap-2">
                                    <span className="text-sm text-gray-400 w-28 truncate">{field.key}</span>
                                    <input
                                      type="text"
                                      value={field.value}
                                      onChange={(e) => updateMetadataValue(idx, e.target.value)}
                                      className="input flex-1"
                                      placeholder="Valor"
                                    />
                                    <button
                                      onClick={() => removeMetadataField(idx)}
                                      className="text-red-400 hover:text-red-300 p-1"
                                      title="Eliminar campo"
                                    >
                                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                      </svg>
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}

                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={newFieldKey}
                                onChange={(e) => setNewFieldKey(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && addMetadataField()}
                                className="input flex-1"
                                placeholder="Nombre del nuevo campo (ej: direccion, cumpleanos)"
                              />
                              <button
                                onClick={addMetadataField}
                                disabled={!newFieldKey.trim()}
                                className="btn btn-secondary text-sm"
                              >
                                Agregar
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="bg-dark-surface rounded p-3">
                              <p className="text-xs text-gray-500 mb-1">Nombre</p>
                              <p className="text-sm text-white">{expandedDetail.name || '-'}</p>
                            </div>
                            <div className="bg-dark-surface rounded p-3">
                              <p className="text-xs text-gray-500 mb-1">Email</p>
                              <p className="text-sm text-white">{expandedDetail.email || '-'}</p>
                            </div>
                          </div>
                          {expandedDetail.tags && expandedDetail.tags.length > 0 && (
                            <div className="bg-dark-surface rounded p-3">
                              <p className="text-xs text-gray-500 mb-2">Etiquetas</p>
                              <div className="flex flex-wrap gap-2">
                                {expandedDetail.tags.map(tag => (
                                  <span key={tag} className="text-xs bg-neon-blue/20 text-neon-blue px-2 py-1 rounded-full">
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {expandedDetail.notes && (
                            <div className="bg-dark-surface rounded p-3">
                              <p className="text-xs text-gray-500 mb-1">Notas</p>
                              <p className="text-sm text-white whitespace-pre-wrap">{expandedDetail.notes}</p>
                            </div>
                          )}
                          
                          {expandedDetail.extractedData && Object.keys(expandedDetail.extractedData).length > 0 && (
                            <div className="bg-dark-surface rounded p-3">
                              <p className="text-xs text-gray-500 mb-2">Datos personalizados</p>
                              <div className="space-y-1">
                                {Object.entries(expandedDetail.extractedData).map(([key, value]) => (
                                  <div key={key} className="flex justify-between text-sm">
                                    <span className="text-gray-400">{key}</span>
                                    <span className="text-white">{value || '-'}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {expandedDetail.instancesUsed && expandedDetail.instancesUsed.length > 0 && (
                        <div>
                          <p className="text-xs text-gray-500 mb-2">Instancias de WhatsApp</p>
                          <div className="flex flex-wrap gap-2">
                            {expandedDetail.instancesUsed.map((inst: any) => (
                              <span 
                                key={inst.id} 
                                className={`text-xs px-2 py-1 rounded ${inst.provider === 'baileys' ? 'bg-green-500/20 text-green-400' : 'bg-blue-500/20 text-blue-400'}`}
                              >
                                {inst.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {expandedDetail.timeline && expandedDetail.timeline.length > 0 && (
                        <div>
                          <p className="text-xs text-gray-500 mb-2">Historial</p>
                          <div className="space-y-2 max-h-36 overflow-y-auto">
                            {expandedDetail.timeline.slice(0, 8).map((event, idx) => (
                              <div key={idx} className="flex items-start gap-2 text-sm">
                                <span className="text-lg">
                                  {event.type === 'order' ? '🛒' : event.type === 'appointment' ? '📅' : '✨'}
                                </span>
                                <div>
                                  <p className="text-white">
                                    {event.type === 'order' && `Pedido ${event.data?.status || ''}`}
                                    {event.type === 'appointment' && `Cita ${event.data?.status || ''}`}
                                    {event.type === 'created' && 'Contacto creado'}
                                  </p>
                                  <p className="text-gray-500 text-xs">{formatDate(event.date)}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="pt-3 border-t border-dark-border flex justify-between text-xs text-gray-500">
                        <span>Creado: {formatDate(expandedDetail.createdAt)}</span>
                        <span>Actualizado: {formatDate(expandedDetail.updatedAt)}</span>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ))}

          {pagination.pages > 1 && (
            <div className="flex justify-center gap-2 mt-4">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="btn btn-secondary text-sm"
              >
                Anterior
              </button>
              <span className="px-4 py-2 text-gray-400">
                {page} de {pagination.pages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(pagination.pages, p + 1))}
                disabled={page === pagination.pages}
                className="btn btn-secondary text-sm"
              >
                Siguiente
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

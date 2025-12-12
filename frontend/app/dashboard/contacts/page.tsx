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
  botDisabled: boolean;
  notes: string | null;
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

export default function ContactsPage() {
  const { currentBusiness } = useBusinessStore();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ total: 0, pages: 1 });
  const [selectedContact, setSelectedContact] = useState<ContactDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [exporting, setExporting] = useState(false);

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
      
      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:3001'}/contacts?${params}`,
        { headers: getAuthHeader() }
      );
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
        `${process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:3001'}/contacts/${encodeURIComponent(phone)}?${params}`,
        { headers: getAuthHeader() }
      );
      setSelectedContact(response.data);
    } catch (error) {
      console.error('Error loading contact detail:', error);
    } finally {
      setLoadingDetail(false);
    }
  };

  const exportCSV = async () => {
    if (!currentBusiness?.id) return;
    
    try {
      setExporting(true);
      const params = new URLSearchParams();
      params.set('businessId', currentBusiness.id);
      
      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:3001'}/contacts/export/csv?${params}`,
        { 
          headers: getAuthHeader(),
          responseType: 'blob'
        }
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
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
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
                <div
                  key={contact.id}
                  onClick={() => loadContactDetail(contact.phone)}
                  className={`card cursor-pointer hover:border-neon-blue/50 transition-colors ${
                    selectedContact?.phone === contact.phone ? 'border-neon-blue' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-neon-blue/20 flex items-center justify-center text-lg">
                        {contact.name ? contact.name.charAt(0).toUpperCase() : '👤'}
                      </div>
                      <div>
                        <p className="text-white font-medium">
                          {contact.name || formatPhone(contact.phone)}
                        </p>
                        <p className="text-gray-400 text-sm">{formatPhone(contact.phone)}</p>
                      </div>
                    </div>
                    <div className="text-right">
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
                  </div>
                  
                  {contact.extractedData && Object.keys(contact.extractedData).length > 0 && (
                    <div className="mt-3 pt-3 border-t border-dark-border flex flex-wrap gap-2">
                      {Object.entries(contact.extractedData).slice(0, 3).map(([key, value]) => (
                        <span key={key} className="text-xs bg-dark-surface px-2 py-1 rounded text-gray-400">
                          {key}: <span className="text-white">{value}</span>
                        </span>
                      ))}
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

        <div className="lg:col-span-1">
          {loadingDetail ? (
            <div className="card">
              <div className="animate-pulse space-y-4">
                <div className="h-20 bg-dark-surface rounded" />
                <div className="h-32 bg-dark-surface rounded" />
              </div>
            </div>
          ) : selectedContact ? (
            <div className="card sticky top-4">
              <div className="text-center mb-4">
                <div className="w-16 h-16 rounded-full bg-neon-blue/20 flex items-center justify-center text-2xl mx-auto mb-2">
                  {selectedContact.name ? selectedContact.name.charAt(0).toUpperCase() : '👤'}
                </div>
                <h2 className="text-lg font-semibold text-white">
                  {selectedContact.name || 'Sin nombre'}
                </h2>
                <p className="text-gray-400">{formatPhone(selectedContact.phone)}</p>
              </div>

              <div className="space-y-4">
                <div>
                  <p className="text-gray-500 text-xs uppercase mb-2">Estadisticas</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-dark-surface rounded p-2 text-center">
                      <p className="text-xl font-bold text-white">{selectedContact.stats?.ordersCount || 0}</p>
                      <p className="text-xs text-gray-400">Pedidos</p>
                    </div>
                    <div className="bg-dark-surface rounded p-2 text-center">
                      <p className="text-xl font-bold text-green-400">
                        S/.{(selectedContact.stats?.totalSpent || 0).toFixed(0)}
                      </p>
                      <p className="text-xs text-gray-400">Total gastado</p>
                    </div>
                    <div className="bg-dark-surface rounded p-2 text-center col-span-2">
                      <p className="text-xl font-bold text-blue-400">{selectedContact.stats?.messagesCount || 0}</p>
                      <p className="text-xs text-gray-400">Mensajes</p>
                    </div>
                  </div>
                </div>

                {selectedContact.instancesUsed && selectedContact.instancesUsed.length > 0 && (
                  <div>
                    <p className="text-gray-500 text-xs uppercase mb-2">Instancias usadas</p>
                    <div className="space-y-1">
                      {selectedContact.instancesUsed.map((inst: any) => (
                        <div key={inst.id} className="flex items-center gap-2 text-sm">
                          <span className={`w-2 h-2 rounded-full ${inst.provider === 'baileys' ? 'bg-green-500' : 'bg-blue-500'}`} />
                          <span className="text-white">{inst.name}</span>
                          <span className="text-gray-500 text-xs">({inst.provider})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {selectedContact.extractedData && Object.keys(selectedContact.extractedData).length > 0 && (
                  <div>
                    <p className="text-gray-500 text-xs uppercase mb-2">Datos extraidos por IA</p>
                    <div className="space-y-1">
                      {Object.entries(selectedContact.extractedData).map(([key, value]) => (
                        <div key={key} className="flex justify-between text-sm">
                          <span className="text-gray-400">{key}</span>
                          <span className="text-white">{value || '-'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {selectedContact.timeline && selectedContact.timeline.length > 0 && (
                  <div>
                    <p className="text-gray-500 text-xs uppercase mb-2">Timeline</p>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {selectedContact.timeline.slice(0, 10).map((event, idx) => (
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

                <div className="pt-4 border-t border-dark-border">
                  <p className="text-gray-500 text-xs">
                    Creado: {formatDate(selectedContact.createdAt)}
                  </p>
                  <p className="text-gray-500 text-xs">
                    Actualizado: {formatDate(selectedContact.updatedAt)}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="card text-center py-12">
              <p className="text-gray-400">Selecciona un contacto para ver detalles</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useBusinessStore } from '@/store/business';
import axios from 'axios';

interface Contact {
  id: string;
  phone: string;
  name: string | null;
}

interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  bodyText: string | null;
}

interface WhatsAppInstance {
  id: string;
  provider: 'BAILEYS' | 'META_CLOUD';
  status: string;
}

interface BroadcastLog {
  id: string;
  contactPhone: string;
  contactName: string | null;
  status: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
  usedTemplate: boolean;
  sentAt: string | null;
  error: string | null;
  createdAt: string;
}

interface Campaign {
  id: string;
  name: string;
  status: 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  messageType: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'TEMPLATE';
  content: string | null;
  mediaUrl: string | null;
  mediaCaption: string | null;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  totalContacts: number;
  sentCount: number;
  failedCount: number;
  progress?: number;
  pending?: number;
  skipped?: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

type MessageType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';

interface CSVContact {
  phone: string;
  variables: string[];
}

export default function BroadcastsPage() {
  const { currentBusiness } = useBusinessStore();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [templates, setTemplates] = useState<MetaTemplate[]>([]);
  const [instance, setInstance] = useState<WhatsAppInstance | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNewCampaign, setShowNewCampaign] = useState(false);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [campaignLogs, setCampaignLogs] = useState<BroadcastLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    content: '',
    includeMedia: false,
    mediaFile: null as File | null,
    mediaUrl: '',
    mediaType: 'IMAGE' as 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT',
    templateId: '',
    delayMinSeconds: 3,
    delayMaxSeconds: 10,
  });

  const [contactSource, setContactSource] = useState<'crm' | 'csv'>('crm');
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [selectAll, setSelectAll] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [csvContacts, setCsvContacts] = useState<CSVContact[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);

  const isMetaCloud = instance?.provider === 'META_CLOUD';

  const [creating, setCreating] = useState(false);

  const getAuthHeader = () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    return { Authorization: `Bearer ${token}` };
  };

  const API_URL = process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:3001';

  const loadCampaigns = async () => {
    if (!currentBusiness?.id) return;
    try {
      setLoading(true);
      const response = await axios.get(`${API_URL}/broadcasts/${currentBusiness.id}`, {
        headers: getAuthHeader()
      });
      setCampaigns(response.data);
    } catch (error) {
      console.error('Error loading campaigns:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadContacts = async () => {
    if (!currentBusiness?.id) return;
    try {
      const response = await axios.get(`${API_URL}/contacts?businessId=${currentBusiness.id}&limit=500`, {
        headers: getAuthHeader()
      });
      setContacts(response.data.contacts || []);
    } catch (error) {
      console.error('Error loading contacts:', error);
    }
  };

  const loadInstanceAndTemplates = async () => {
    if (!currentBusiness?.id) return;
    try {
      const instanceResponse = await axios.get(`${API_URL}/wa/${currentBusiness.id}/status`, {
        headers: getAuthHeader()
      });
      const inst = instanceResponse.data;
      setInstance(inst);

      if (inst?.provider === 'META_CLOUD') {
        const templatesResponse = await axios.get(`${API_URL}/templates/${currentBusiness.id}`, {
          headers: getAuthHeader()
        });
        const approvedTemplates = (templatesResponse.data || []).filter(
          (t: MetaTemplate) => t.status === 'APPROVED'
        );
        setTemplates(approvedTemplates);
      }
    } catch (error) {
      console.error('Error loading instance/templates:', error);
    }
  };

  const loadCampaignDetails = async (campaignId: string) => {
    if (!currentBusiness?.id) return;
    try {
      const response = await axios.get(`${API_URL}/broadcasts/${currentBusiness.id}/${campaignId}`, {
        headers: getAuthHeader()
      });
      setSelectedCampaign(response.data);
    } catch (error) {
      console.error('Error loading campaign details:', error);
    }
  };

  const loadCampaignLogs = async (campaignId: string) => {
    if (!currentBusiness?.id) return;
    try {
      setLoadingLogs(true);
      const response = await axios.get(`${API_URL}/broadcasts/${currentBusiness.id}/${campaignId}/logs?limit=100`, {
        headers: getAuthHeader()
      });
      setCampaignLogs(response.data.logs || []);
    } catch (error) {
      console.error('Error loading logs:', error);
    } finally {
      setLoadingLogs(false);
    }
  };

  const parseCSV = (text: string): CSVContact[] => {
    const lines = text.trim().split('\n').filter(l => l.trim());
    const result: CSVContact[] = [];
    const seenPhones = new Set<string>();
    
    for (const line of lines) {
      const parts = line.split(',').map(p => p.trim());
      if (parts.length > 0 && parts[0]) {
        const phone = parts[0].replace(/\D/g, '');
        if (phone.length >= 10 && !seenPhones.has(phone)) {
          seenPhones.add(phone);
          result.push({
            phone,
            variables: parts.slice(1)
          });
        }
      }
    }
    return result;
  };

  const handleCSVChange = (text: string) => {
    setCsvText(text);
    setCsvContacts(parseCSV(text));
  };

  const handleCSVFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    handleCSVChange(text);
  };

  const handleMediaFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentBusiness?.id) return;

    setFormData(prev => ({ ...prev, mediaFile: file, mediaUrl: '' }));
    setUploadingMedia(true);

    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('businessId', currentBusiness.id);

      const response = await axios.post(`${API_URL}/media/upload`, fd, {
        headers: {
          ...getAuthHeader(),
          'Content-Type': 'multipart/form-data'
        }
      });

      setFormData(prev => ({ ...prev, mediaUrl: response.data.url }));
    } catch (error: any) {
      console.error('Error uploading media:', error);
      alert('Error subiendo archivo: ' + (error.response?.data?.error || error.message));
      setFormData(prev => ({ ...prev, mediaFile: null }));
    } finally {
      setUploadingMedia(false);
    }
  };

  const createCampaign = async () => {
    if (!currentBusiness?.id) return;
    if (!formData.name.trim()) {
      alert('El nombre de la campana es requerido');
      return;
    }

    const finalContacts = contactSource === 'crm' 
      ? selectedContacts.map(phone => ({ phone, variables: [] as string[] }))
      : csvContacts;

    if (finalContacts.length === 0) {
      alert('Selecciona al menos un contacto');
      return;
    }

    if (!formData.content.trim() && !formData.includeMedia) {
      alert('Debes incluir un mensaje o un archivo');
      return;
    }

    if (formData.includeMedia && !formData.mediaUrl) {
      alert('Sube un archivo primero');
      return;
    }

    try {
      setCreating(true);

      const messageType = formData.includeMedia ? formData.mediaType : 'TEXT';
      const mediaCaption = formData.includeMedia && formData.content.trim() ? formData.content : undefined;

      const response = await axios.post(`${API_URL}/broadcasts/${currentBusiness.id}`, {
        name: formData.name,
        messageType,
        content: formData.includeMedia ? undefined : formData.content || undefined,
        mediaUrl: formData.includeMedia ? formData.mediaUrl : undefined,
        mediaCaption,
        templateId: formData.templateId || undefined,
        contactsWithVariables: finalContacts,
        delayMinSeconds: formData.delayMinSeconds,
        delayMaxSeconds: formData.delayMaxSeconds
      }, { headers: getAuthHeader() });

      alert(`Campana creada con ${response.data.totalContacts} contactos`);
      setShowNewCampaign(false);
      setFormData({
        name: '',
        content: '',
        includeMedia: false,
        mediaFile: null,
        mediaUrl: '',
        mediaType: 'IMAGE',
        templateId: '',
        delayMinSeconds: 3,
        delayMaxSeconds: 10,
      });
      setContactSource('crm');
      setSelectedContacts([]);
      setSelectAll(false);
      setCsvText('');
      setCsvContacts([]);
      loadCampaigns();
    } catch (error: any) {
      console.error('Error creating campaign:', error);
      alert(error.response?.data?.error || 'Error creando campana');
    } finally {
      setCreating(false);
    }
  };

  const startCampaign = async (campaignId: string) => {
    if (!currentBusiness?.id) return;
    try {
      await axios.post(`${API_URL}/broadcasts/${currentBusiness.id}/${campaignId}/start`, {}, {
        headers: getAuthHeader()
      });
      alert('Campana iniciada');
      loadCampaigns();
      if (selectedCampaign?.id === campaignId) {
        loadCampaignDetails(campaignId);
      }
    } catch (error: any) {
      alert(error.response?.data?.error || 'Error iniciando campana');
    }
  };

  const pauseCampaign = async (campaignId: string) => {
    if (!currentBusiness?.id) return;
    try {
      await axios.post(`${API_URL}/broadcasts/${currentBusiness.id}/${campaignId}/pause`, {}, {
        headers: getAuthHeader()
      });
      alert('Campana pausada');
      loadCampaigns();
      if (selectedCampaign?.id === campaignId) {
        loadCampaignDetails(campaignId);
      }
    } catch (error: any) {
      alert(error.response?.data?.error || 'Error pausando campana');
    }
  };

  const cancelCampaign = async (campaignId: string) => {
    if (!currentBusiness?.id) return;
    if (!confirm('Estas seguro de cancelar esta campana?')) return;
    try {
      await axios.post(`${API_URL}/broadcasts/${currentBusiness.id}/${campaignId}/cancel`, {}, {
        headers: getAuthHeader()
      });
      alert('Campana cancelada');
      loadCampaigns();
      if (selectedCampaign?.id === campaignId) {
        loadCampaignDetails(campaignId);
      }
    } catch (error: any) {
      alert(error.response?.data?.error || 'Error cancelando campana');
    }
  };

  const deleteCampaign = async (campaignId: string) => {
    if (!currentBusiness?.id) return;
    if (!confirm('Estas seguro de eliminar esta campana?')) return;
    try {
      await axios.delete(`${API_URL}/broadcasts/${currentBusiness.id}/${campaignId}`, {
        headers: getAuthHeader()
      });
      alert('Campana eliminada');
      loadCampaigns();
      if (selectedCampaign?.id === campaignId) {
        setSelectedCampaign(null);
      }
    } catch (error: any) {
      alert(error.response?.data?.error || 'Error eliminando campana');
    }
  };


  const toggleSelectAll = () => {
    if (selectAll) {
      setSelectedContacts([]);
      setSelectAll(false);
    } else {
      setSelectedContacts(contacts.map(c => c.phone));
      setSelectAll(true);
    }
  };

  const toggleContact = (phone: string) => {
    if (selectedContacts.includes(phone)) {
      setSelectedContacts(prev => prev.filter(p => p !== phone));
      setSelectAll(false);
    } else {
      setSelectedContacts(prev => [...prev, phone]);
    }
  };

  useEffect(() => {
    if (currentBusiness?.id) {
      loadCampaigns();
      loadContacts();
      loadInstanceAndTemplates();
    }
  }, [currentBusiness?.id]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (selectedCampaign?.status === 'RUNNING') {
      interval = setInterval(() => {
        loadCampaignDetails(selectedCampaign.id);
        loadCampaignLogs(selectedCampaign.id);
      }, 3000);
    }
    return () => clearInterval(interval);
  }, [selectedCampaign?.id, selectedCampaign?.status]);

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      DRAFT: 'bg-gray-100 text-gray-800',
      SCHEDULED: 'bg-blue-100 text-blue-800',
      RUNNING: 'bg-green-100 text-green-800',
      PAUSED: 'bg-yellow-100 text-yellow-800',
      COMPLETED: 'bg-emerald-100 text-emerald-800',
      CANCELLED: 'bg-red-100 text-red-800',
      FAILED: 'bg-red-100 text-red-800'
    };
    return colors[status] || 'bg-gray-100 text-gray-800';
  };

  const getLogStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      PENDING: 'bg-gray-100 text-gray-600',
      SENDING: 'bg-blue-100 text-blue-600',
      SENT: 'bg-green-100 text-green-600',
      FAILED: 'bg-red-100 text-red-600',
      SKIPPED: 'bg-yellow-100 text-yellow-600'
    };
    return colors[status] || 'bg-gray-100 text-gray-600';
  };

  if (!currentBusiness) {
    return <div className="p-6 text-gray-500">Selecciona un negocio primero</div>;
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Envio Masivo</h1>
        <button
          onClick={() => setShowNewCampaign(true)}
          className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
        >
          + Nueva Campana
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg shadow">
          <div className="p-4 border-b">
            <h2 className="text-lg font-semibold">Campanas</h2>
          </div>
          <div className="divide-y max-h-[600px] overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center text-gray-500">Cargando...</div>
            ) : campaigns.length === 0 ? (
              <div className="p-4 text-center text-gray-500">No hay campanas</div>
            ) : (
              campaigns.map(campaign => (
                <div
                  key={campaign.id}
                  className={`p-4 cursor-pointer hover:bg-gray-50 ${selectedCampaign?.id === campaign.id ? 'bg-blue-50' : ''}`}
                  onClick={() => {
                    setSelectedCampaign(campaign);
                    loadCampaignDetails(campaign.id);
                    loadCampaignLogs(campaign.id);
                  }}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-medium text-gray-900">{campaign.name}</h3>
                      <p className="text-sm text-gray-500">{campaign.messageType}</p>
                    </div>
                    <span className={`px-2 py-1 text-xs rounded-full ${getStatusBadge(campaign.status)}`}>
                      {campaign.status}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-4 text-sm text-gray-500">
                    <span>{campaign.totalContacts} contactos</span>
                    <span className="text-green-600">{campaign.sentCount} enviados</span>
                    {campaign.failedCount > 0 && (
                      <span className="text-red-600">{campaign.failedCount} fallidos</span>
                    )}
                  </div>
                  {campaign.status === 'RUNNING' && (
                    <div className="mt-2">
                      <div className="w-full bg-gray-200 rounded-full h-2">
                        <div
                          className="bg-green-600 h-2 rounded-full transition-all"
                          style={{ width: `${campaign.progress || 0}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow">
          {selectedCampaign ? (
            <>
              <div className="p-4 border-b">
                <div className="flex justify-between items-start">
                  <div>
                    <h2 className="text-lg font-semibold">{selectedCampaign.name}</h2>
                    <span className={`px-2 py-1 text-xs rounded-full ${getStatusBadge(selectedCampaign.status)}`}>
                      {selectedCampaign.status}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    {selectedCampaign.status === 'DRAFT' && (
                      <button
                        onClick={() => startCampaign(selectedCampaign.id)}
                        className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700"
                      >
                        Iniciar
                      </button>
                    )}
                    {selectedCampaign.status === 'RUNNING' && (
                      <button
                        onClick={() => pauseCampaign(selectedCampaign.id)}
                        className="px-3 py-1 bg-yellow-600 text-white text-sm rounded hover:bg-yellow-700"
                      >
                        Pausar
                      </button>
                    )}
                    {selectedCampaign.status === 'PAUSED' && (
                      <button
                        onClick={() => startCampaign(selectedCampaign.id)}
                        className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700"
                      >
                        Reanudar
                      </button>
                    )}
                    {['DRAFT', 'RUNNING', 'PAUSED'].includes(selectedCampaign.status) && (
                      <button
                        onClick={() => cancelCampaign(selectedCampaign.id)}
                        className="px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700"
                      >
                        Cancelar
                      </button>
                    )}
                    {['COMPLETED', 'CANCELLED', 'FAILED'].includes(selectedCampaign.status) && (
                      <button
                        onClick={() => deleteCampaign(selectedCampaign.id)}
                        className="px-3 py-1 bg-gray-600 text-white text-sm rounded hover:bg-gray-700"
                      >
                        Eliminar
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="p-4 border-b bg-gray-50">
                <div className="grid grid-cols-4 gap-4 text-center">
                  <div>
                    <p className="text-2xl font-bold text-gray-900">{selectedCampaign.totalContacts}</p>
                    <p className="text-xs text-gray-500">Total</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-green-600">{selectedCampaign.sentCount}</p>
                    <p className="text-xs text-gray-500">Enviados</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-red-600">{selectedCampaign.failedCount}</p>
                    <p className="text-xs text-gray-500">Fallidos</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-gray-600">{selectedCampaign.pending || 0}</p>
                    <p className="text-xs text-gray-500">Pendientes</p>
                  </div>
                </div>
                {selectedCampaign.status === 'RUNNING' && (
                  <div className="mt-3">
                    <div className="w-full bg-gray-200 rounded-full h-3">
                      <div
                        className="bg-green-600 h-3 rounded-full transition-all"
                        style={{ width: `${selectedCampaign.progress || 0}%` }}
                      />
                    </div>
                    <p className="text-center text-sm text-gray-500 mt-1">{selectedCampaign.progress || 0}%</p>
                  </div>
                )}
              </div>

              <div className="p-4">
                <h3 className="font-medium text-gray-900 mb-3">Logs de Envio</h3>
                <div className="max-h-[300px] overflow-y-auto space-y-2">
                  {loadingLogs ? (
                    <p className="text-gray-500 text-sm">Cargando logs...</p>
                  ) : campaignLogs.length === 0 ? (
                    <p className="text-gray-500 text-sm">No hay logs aun</p>
                  ) : (
                    campaignLogs.map(log => (
                      <div key={log.id} className="flex items-center justify-between p-2 bg-gray-50 rounded text-sm">
                        <div>
                          <span className="font-medium">{log.contactName || log.contactPhone}</span>
                          {log.contactName && <span className="text-gray-400 ml-1">({log.contactPhone})</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          {log.usedTemplate && (
                            <span className="text-xs text-blue-600">Plantilla</span>
                          )}
                          <span className={`px-2 py-0.5 text-xs rounded ${getLogStatusBadge(log.status)}`}>
                            {log.status}
                          </span>
                          {log.sentAt && (
                            <span className="text-xs text-gray-400">
                              {new Date(log.sentAt).toLocaleTimeString()}
                            </span>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="p-8 text-center text-gray-500">
              Selecciona una campana para ver detalles
            </div>
          )}
        </div>
      </div>

      {showNewCampaign && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-4 border-b flex justify-between items-center">
              <h2 className="text-lg font-semibold">Nueva Campana de Envio Masivo</h2>
              <button onClick={() => setShowNewCampaign(false)} className="text-gray-500 hover:text-gray-700">
                X
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nombre de la Campana</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2"
                  placeholder="Ej: Promocion de Navidad"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mensaje de Texto</label>
                <textarea
                  value={formData.content}
                  onChange={e => setFormData(prev => ({ ...prev, content: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2"
                  rows={4}
                  placeholder="Escribe tu mensaje aqui... Usa {{1}}, {{2}} para variables del CSV"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Usa variables como {'{{1}}'}, {'{{2}}'} que seran reemplazadas con datos del CSV
                </p>
              </div>

              <div className="border rounded-lg p-4 bg-gray-50">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.includeMedia}
                    onChange={e => setFormData(prev => ({ ...prev, includeMedia: e.target.checked }))}
                    className="w-4 h-4"
                  />
                  <span className="text-sm font-medium text-gray-700">Incluir archivo (imagen, video, audio o documento)</span>
                </label>

                {formData.includeMedia && (
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de Archivo</label>
                      <select
                        value={formData.mediaType}
                        onChange={e => setFormData(prev => ({ ...prev, mediaType: e.target.value as 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' }))}
                        className="w-full border rounded-lg px-3 py-2"
                      >
                        <option value="IMAGE">Imagen</option>
                        <option value="VIDEO">Video</option>
                        <option value="AUDIO">Audio</option>
                        <option value="DOCUMENT">Documento</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Subir Archivo</label>
                      <input
                        type="file"
                        onChange={handleMediaFileChange}
                        accept={
                          formData.mediaType === 'IMAGE' ? 'image/*' :
                          formData.mediaType === 'VIDEO' ? 'video/*' :
                          formData.mediaType === 'AUDIO' ? 'audio/*' :
                          '*'
                        }
                        className="w-full border rounded-lg px-3 py-2"
                        disabled={uploadingMedia}
                      />
                      {uploadingMedia && (
                        <p className="text-sm text-blue-600 mt-1">Subiendo archivo...</p>
                      )}
                      {formData.mediaUrl && (
                        <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded text-sm">
                          <p className="text-green-700 font-medium">Archivo subido correctamente</p>
                          <p className="text-green-600 text-xs break-all">{formData.mediaUrl}</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {isMetaCloud && templates.length > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <label className="block text-sm font-medium text-blue-800 mb-2">
                    Plantilla para contactos fuera de ventana 24h (Meta Cloud)
                  </label>
                  <select
                    value={formData.templateId}
                    onChange={e => setFormData(prev => ({ ...prev, templateId: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2"
                  >
                    <option value="">Sin plantilla (solo ventana 24h)</option>
                    {templates.map(template => (
                      <option key={template.id} value={template.id}>
                        {template.name} ({template.language})
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-blue-600 mt-2">
                    Los contactos que no hayan escrito en 24h recibiran esta plantilla en lugar del mensaje normal.
                  </p>
                </div>
              )}

              {isMetaCloud && templates.length === 0 && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                  <p className="text-sm text-yellow-800">
                    No tienes plantillas aprobadas. Los contactos fuera de la ventana de 24h no recibiran mensajes.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Delay Minimo (seg)</label>
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={formData.delayMinSeconds}
                    onChange={e => setFormData(prev => ({ ...prev, delayMinSeconds: parseInt(e.target.value) || 3 }))}
                    className="w-full border rounded-lg px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Delay Maximo (seg)</label>
                  <input
                    type="number"
                    min="1"
                    max="120"
                    value={formData.delayMaxSeconds}
                    onChange={e => setFormData(prev => ({ ...prev, delayMaxSeconds: parseInt(e.target.value) || 10 }))}
                    className="w-full border rounded-lg px-3 py-2"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-500">
                Cada mensaje se enviara con un delay aleatorio entre {formData.delayMinSeconds} y {formData.delayMaxSeconds} segundos
              </p>

              <div className="border-t pt-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">Origen de Contactos</label>
                <div className="flex gap-4 mb-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="contactSource"
                      checked={contactSource === 'crm'}
                      onChange={() => setContactSource('crm')}
                    />
                    <span className="text-sm">Contactos CRM</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="contactSource"
                      checked={contactSource === 'csv'}
                      onChange={() => setContactSource('csv')}
                    />
                    <span className="text-sm">Importar CSV</span>
                  </label>
                </div>

                {contactSource === 'crm' && (
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-sm text-gray-600">Seleccionar de tu lista de contactos</span>
                      <button
                        type="button"
                        onClick={toggleSelectAll}
                        className="text-sm text-blue-600 hover:text-blue-800"
                      >
                        {selectAll ? 'Deseleccionar todos' : 'Seleccionar todos'}
                      </button>
                    </div>
                    <div className="border rounded-lg max-h-48 overflow-y-auto">
                      {contacts.length === 0 ? (
                        <p className="p-3 text-gray-500 text-sm">No hay contactos</p>
                      ) : (
                        contacts.map(contact => (
                          <label
                            key={contact.id}
                            className="flex items-center p-2 hover:bg-gray-50 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={selectedContacts.includes(contact.phone)}
                              onChange={() => toggleContact(contact.phone)}
                              className="mr-3"
                            />
                            <span className="text-sm">
                              {contact.name || contact.phone}
                              {contact.name && <span className="text-gray-400 ml-1">({contact.phone})</span>}
                            </span>
                          </label>
                        ))
                      )}
                    </div>
                    <p className="text-sm text-gray-500 mt-1">{selectedContacts.length} contactos seleccionados</p>
                  </div>
                )}

                {contactSource === 'csv' && (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">Subir archivo CSV</label>
                      <input
                        type="file"
                        accept=".csv,.txt"
                        onChange={handleCSVFileUpload}
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">O pegar contenido CSV</label>
                      <textarea
                        value={csvText}
                        onChange={e => handleCSVChange(e.target.value)}
                        className="w-full border rounded-lg px-3 py-2 font-mono text-sm"
                        rows={5}
                        placeholder={"phone,nombre,variable2\n5491155551234,Juan,VIP\n5491155555678,Maria,Regular"}
                      />
                    </div>
                    <p className="text-xs text-gray-500">
                      Formato: telefono,variable1,variable2,... (la primera columna es el telefono)
                    </p>
                    {csvContacts.length > 0 && (
                      <div className="p-2 bg-green-50 border border-green-200 rounded">
                        <p className="text-sm text-green-700">
                          {csvContacts.length} contactos importados
                          {csvContacts[0]?.variables.length > 0 && (
                            <span> con {csvContacts[0].variables.length} variable(s)</span>
                          )}
                        </p>
                        <div className="text-xs text-green-600 mt-1 max-h-20 overflow-y-auto">
                          {csvContacts.slice(0, 5).map((c, i) => (
                            <div key={i}>{c.phone} {c.variables.length > 0 && `- ${c.variables.join(', ')}`}</div>
                          ))}
                          {csvContacts.length > 5 && <div>...y {csvContacts.length - 5} mas</div>}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="p-4 border-t flex justify-end gap-3">
              <button
                onClick={() => setShowNewCampaign(false)}
                className="px-4 py-2 border rounded-lg hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={createCampaign}
                disabled={creating}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {creating ? 'Creando...' : 'Crear Campana'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import axios from 'axios';

const api = axios.create({
  baseURL: '/api'
});

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;

export const authApi = {
  register: (data: { name: string; email: string; password: string }) =>
    api.post('/auth/register', data),
  login: (data: { email: string; password: string }) =>
    api.post('/auth/login', data),
  me: () => api.get('/auth/me')
};

export const businessApi = {
  list: () => api.get('/business'),
  get: (id: string) => api.get(`/business/${id}`),
  create: (data: any) => api.post('/business', data),
  update: (id: string, data: any) => api.put(`/business/${id}`, data),
  updateOpenAI: (id: string, data: any) => api.put(`/business/${id}/openai`, data),
  toggleBot: (id: string, enabled?: boolean) => 
    api.put(`/business/${id}/bot-toggle`, { botEnabled: enabled }),
  delete: (id: string) => api.delete(`/business/${id}`)
};

export const productApi = {
  list: (businessId: string) => api.get(`/products?business_id=${businessId}`),
  create: (data: any) => api.post('/products', data),
  update: (id: string, data: any) => api.put(`/products/${id}`, data),
  delete: (id: string) => api.delete(`/products/${id}`)
};

export const policyApi = {
  get: (businessId: string) => api.get(`/policies?business_id=${businessId}`),
  create: (data: any) => api.post('/policies', data),
  update: (id: string, data: any) => api.put(`/policies/${id}`, data)
};

export const promptApi = {
  get: (businessId: string) => api.get(`/agent/prompt?business_id=${businessId}`),
  save: (data: { 
    businessId: string; 
    prompt: string; 
    bufferSeconds?: number;
    historyLimit?: number;
    splitMessages?: boolean;
  }) => api.post('/agent/prompt', data),
  update: (id: string, data: any) => api.put(`/agent/prompt/${id}`, data)
};

export const toolsApi = {
  list: (businessId: string) => api.get(`/agent/tools?business_id=${businessId}`),
  create: (data: {
    business_id: string;
    name: string;
    description: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    bodyTemplate?: any;
  }) => api.post('/agent/tools', data),
  update: (id: string, data: any) => api.put(`/agent/tools/${id}`, data),
  delete: (id: string) => api.delete(`/agent/tools/${id}`),
  test: (id: string, testPayload?: any) => api.post(`/agent/tools/${id}/test`, { testPayload }),
  logs: (id: string, limit?: number, offset?: number) => 
    api.get(`/agent/tools/${id}/logs?limit=${limit || 50}&offset=${offset || 0}`),
  stats: (id: string) => api.get(`/agent/tools/${id}/stats`)
};

export const waApi = {
  create: (businessId: string) => api.post('/wa/create', { businessId }),
  status: (businessId: string) => api.get(`/wa/${businessId}/status`),
  qr: (businessId: string) => api.get(`/wa/${businessId}/qr`),
  send: (businessId: string, data: any) => api.post(`/wa/${businessId}/send`, data),
  restart: (businessId: string) => api.post(`/wa/${businessId}/restart`),
  delete: (businessId: string) => api.delete(`/wa/${businessId}`)
};

export const messageApi = {
  conversations: (businessId: string) => 
    api.get(`/messages/conversations?business_id=${businessId}`),
  conversation: (businessId: string, phone: string) => 
    api.get(`/messages/conversation/${phone}?business_id=${businessId}`)
};

export const mediaApi = {
  upload: (businessId: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('businessId', businessId);
    return api.post('/media/upload', formData);
  }
};

export const remindersApi = {
  getConfig: (businessId: string) => api.get(`/reminders/config/${businessId}`),
  updateConfig: (businessId: string, data: any) => api.put(`/reminders/config/${businessId}`, data),
  list: (businessId: string, status?: string, contactPhone?: string) => {
    let url = `/reminders/${businessId}`;
    const params = [];
    if (status) params.push(`status=${status}`);
    if (contactPhone) params.push(`contactPhone=${contactPhone}`);
    if (params.length) url += '?' + params.join('&');
    return api.get(url);
  },
  create: (data: {
    business_id: string;
    contact_phone: string;
    contact_name?: string;
    scheduled_at: string;
    message_template?: string;
    type?: string;
  }) => api.post('/reminders', data),
  cancel: (id: string) => api.delete(`/reminders/${id}`),
  pendingCount: (businessId: string) => api.get(`/reminders/pending/count/${businessId}`)
};

export const tagsApi = {
  list: (businessId: string) => api.get(`/tags?business_id=${businessId}`),
  create: (data: { business_id: string; name: string; color?: string; description?: string }) =>
    api.post('/tags', data),
  update: (id: string, data: { name?: string; color?: string; description?: string; order?: number }) =>
    api.put(`/tags/${id}`, data),
  delete: (id: string) => api.delete(`/tags/${id}`),
  reorder: (businessId: string, tagOrders: { id: string; order: number }[]) =>
    api.put('/tags/reorder', { business_id: businessId, tag_orders: tagOrders }),
  initDefaults: (businessId: string) =>
    api.post('/tags/init-defaults', { business_id: businessId }),
  setStagePrompt: (tagId: string, data: { promptOverride?: string; systemContext?: string }) =>
    api.post(`/tags/${tagId}/stage-prompt`, data),
  assign: (data: { business_id: string; contact_phone: string; tag_id: string; source?: string }) =>
    api.post('/tags/assign', data),
  unassign: (data: { business_id: string; contact_phone: string }) =>
    api.delete('/tags/assign', { data }),
  getAssignments: (businessId: string, tagId?: string) =>
    api.get(`/tags/assignments?business_id=${businessId}${tagId ? `&tag_id=${tagId}` : ''}`),
  getContactTag: (businessId: string, contactPhone: string) =>
    api.get(`/tags/contact/${contactPhone}?business_id=${businessId}`),
  getHistory: (businessId: string, contactPhone: string) =>
    api.get(`/tags/history/${contactPhone}?business_id=${businessId}`),
  suggestStage: (businessId: string, contactPhone: string) =>
    api.post('/tags/suggest-stage', { business_id: businessId, contact_phone: contactPhone })
};

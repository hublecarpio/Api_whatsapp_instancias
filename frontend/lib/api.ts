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

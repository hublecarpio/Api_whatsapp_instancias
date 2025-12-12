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
    if (typeof window !== 'undefined') {
      if (error.response?.status === 401) {
        const currentPath = window.location.pathname;
        if (!currentPath.includes('/login') && !currentPath.includes('/register')) {
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          window.location.href = '/login';
        }
      }
    }
    return Promise.reject(error);
  }
);

export default api;

export const authApi = {
  register: (data: { name: string; email: string; password: string; referralCode?: string }) =>
    api.post('/auth/register', data),
  login: (data: { email: string; password: string }) =>
    api.post('/auth/login', data),
  me: () => api.get('/auth/me'),
  resendVerification: () => api.post('/auth/resend-verification'),
  verifyEmail: (token: string) => api.get(`/auth/verify-email?token=${token}`),
  applyReferral: (code: string) => api.post('/auth/apply-referral', { code }),
  getAdvisorInvitation: (token: string) => api.get(`/auth/advisor-invitation/${token}`),
  advisorSignup: (data: { token: string; name: string; password: string }) =>
    api.post('/auth/advisor-signup', data)
};

export const businessApi = {
  list: () => api.get('/business'),
  get: (id: string) => api.get(`/business/${id}`),
  create: (data: any) => api.post('/business', data),
  update: (id: string, data: any) => api.put(`/business/${id}`, data),
  updateOpenAI: (id: string, data: any) => api.put(`/business/${id}/openai`, data),
  toggleBot: (id: string, enabled?: boolean) => 
    api.put(`/business/${id}/bot-toggle`, { botEnabled: enabled }),
  delete: (id: string) => api.delete(`/business/${id}`),
  getInjectionCode: (id: string) => api.get(`/business/${id}/injection-code`),
  generateInjectionCode: (id: string) => api.post(`/business/${id}/generate-injection-code`)
};

export const productApi = {
  list: (businessId: string) => api.get(`/products?business_id=${businessId}`),
  create: (data: any) => api.post('/products', data),
  update: (id: string, data: any) => api.put(`/products/${id}`, data),
  delete: (id: string) => api.delete(`/products/${id}`),
  bulkCreate: (businessId: string, products: any[]) => api.post('/products/bulk', { businessId, products }),
  search: (businessId: string, query: string, limit?: number) => api.post('/products/search', { businessId, query, limit })
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
    parameters?: Array<{ name: string; type: string; description: string; required?: boolean }>;
  }) => api.post('/agent/tools', data),
  update: (id: string, data: any) => api.put(`/agent/tools/${id}`, data),
  delete: (id: string) => api.delete(`/agent/tools/${id}`),
  test: (id: string, testPayload?: any) => api.post(`/agent/tools/${id}/test`, { testPayload }),
  logs: (id: string, limit?: number, offset?: number) => 
    api.get(`/agent/tools/${id}/logs?limit=${limit || 50}&offset=${offset || 0}`),
  stats: (id: string) => api.get(`/agent/tools/${id}/stats`)
};

export const waApi = {
  create: (businessId: string, phoneNumber?: string) => 
    api.post('/wa/create', { businessId, phoneNumber }),
  createMeta: (data: {
    businessId: string;
    name?: string;
    accessToken: string;
    metaBusinessId: string;
    phoneNumberId: string;
    appId: string;
    appSecret: string;
    phoneNumber?: string;
  }) => api.post('/wa/create-meta', data),
  instances: (businessId: string) => api.get(`/wa/instances/${businessId}`),
  status: (businessId: string) => api.get(`/wa/${businessId}/status`),
  qr: (businessId: string) => api.get(`/wa/${businessId}/qr`),
  send: (businessId: string, data: any) => api.post(`/wa/${businessId}/send`, data),
  restart: (businessId: string) => api.post(`/wa/${businessId}/restart`),
  delete: (businessId: string) => api.delete(`/wa/${businessId}`),
  history: (businessId: string, limit?: number) => 
    api.get(`/wa/${businessId}/history${limit ? `?limit=${limit}` : ''}`),
  validate: (businessId: string) => api.post(`/wa/${businessId}/validate`)
};

export const messageApi = {
  conversations: (businessId: string) => 
    api.get(`/messages/conversations?business_id=${businessId}`),
  conversation: (businessId: string, phone: string) => 
    api.get(`/messages/conversation/${phone}?business_id=${businessId}`),
  windowStatus: (businessId: string, phone: string) =>
    api.get(`/messages/conversation/${phone}/window-status?business_id=${businessId}`),
  send: (businessId: string, to: string, message: string) =>
    api.post(`/wa/${businessId}/send`, { to, message })
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

export const templatesApi = {
  list: (businessId: string) => api.get(`/templates/${businessId}`),
  sync: (businessId: string) => api.post(`/templates/${businessId}/sync`),
  create: (businessId: string, data: {
    name: string;
    language?: string;
    category?: string;
    headerType?: string;
    headerText?: string;
    headerMediaUrl?: string;
    bodyText: string;
    footerText?: string;
    buttons?: Array<{ type: string; text: string; url?: string; phone_number?: string }>;
  }) => api.post(`/templates/${businessId}/create`, data),
  delete: (businessId: string, templateId: string) => api.delete(`/templates/${businessId}/${templateId}`),
  send: (businessId: string, data: {
    templateName: string;
    to: string;
    variables?: string[];
    headerVariables?: string[];
  }) => api.post(`/templates/${businessId}/send-template`, data)
};

export const billingApi = {
  createCheckoutSession: () => api.post('/billing/create-checkout-session'),
  getSubscriptionStatus: () => api.get('/billing/subscription-status'),
  cancelSubscription: () => api.post('/billing/cancel-subscription'),
  reactivateSubscription: () => api.post('/billing/reactivate-subscription'),
  getAccessStatus: (businessId?: string) => 
    api.get(`/billing/access-status${businessId ? `?businessId=${businessId}` : ''}`),
  getContactsToday: (businessId?: string) =>
    api.get(`/billing/contacts-today${businessId ? `?businessId=${businessId}` : ''}`)
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
    api.post('/tags/suggest-stage', { business_id: businessId, contact_phone: contactPhone }),
  getContactBotStatus: (businessId: string, contactPhone: string) =>
    api.get(`/tags/contact/${contactPhone}/bot-status?business_id=${businessId}`),
  toggleContactBot: (businessId: string, contactPhone: string, botDisabled: boolean) =>
    api.patch(`/tags/contact/${contactPhone}/bot-toggle`, { business_id: businessId, botDisabled }),
  getContactExtractedData: (businessId: string, contactPhone: string) =>
    api.get(`/tags/contact/${contactPhone}/extracted-data?business_id=${businessId}`)
};

export const ordersApi = {
  list: (businessId: string, status?: string) =>
    api.get(`/orders?businessId=${businessId}${status ? `&status=${status}` : ''}`),
  syncPayment: (sessionId: string) =>
    api.post(`/orders/sync-payment/${sessionId}`),
  get: (orderId: string) => api.get(`/orders/${orderId}`),
  updateStatus: (orderId: string, status: string) =>
    api.patch(`/orders/${orderId}/status`, { status }),
  confirmPayment: (orderId: string) =>
    api.post(`/orders/${orderId}/confirm-payment`),
  attachVoucher: (orderId: string, voucherImageUrl: string) =>
    api.post(`/orders/${orderId}/voucher`, { voucherImageUrl }),
  createPaymentLink: (data: {
    businessId: string;
    contactPhone: string;
    contactName?: string;
    items: Array<{ productId: string; quantity: number }>;
    shippingAddress?: string;
    shippingCity?: string;
    shippingCountry?: string;
  }) => api.post('/orders/create-payment-link', data),
  listPaymentLinks: (businessId: string, status?: string) =>
    api.get(`/orders/payment-links?businessId=${businessId}${status ? `&status=${status}` : ''}`)
};

export const extractionApi = {
  getFields: (businessId: string) =>
    api.get(`/extraction/fields/${businessId}`),
  createField: (businessId: string, data: { fieldKey: string; fieldLabel: string; fieldType?: string; required?: boolean }) =>
    api.post(`/extraction/fields/${businessId}`, data),
  updateField: (businessId: string, fieldId: string, data: { fieldLabel?: string; required?: boolean; enabled?: boolean; order?: number }) =>
    api.patch(`/extraction/fields/${businessId}/${fieldId}`, data),
  deleteField: (businessId: string, fieldId: string) =>
    api.delete(`/extraction/fields/${businessId}/${fieldId}`),
  reorderFields: (businessId: string, fieldIds: string[]) =>
    api.put(`/extraction/fields/${businessId}/reorder`, { fieldIds }),
  getContactData: (businessId: string, contactPhone: string) =>
    api.get(`/extraction/contact/${businessId}/${contactPhone}`),
  updateContactData: (businessId: string, contactPhone: string, data: Record<string, string>) =>
    api.patch(`/extraction/contact/${businessId}/${contactPhone}`, { data })
};

export const agentV2Api = {
  getConfig: (businessId: string) =>
    api.get(`/agent-v2/config/${businessId}`),
  saveConfig: (businessId: string, data: {
    skills?: {
      search_product?: boolean;
      payment?: boolean;
      followup?: boolean;
      media?: boolean;
      crm?: boolean;
    };
    prompts?: {
      vendor?: string;
      observer?: string;
      refiner?: string;
    };
  }) => api.put(`/agent-v2/config/${businessId}`, data),
  getLeadMemory: (businessId: string, leadId: string) =>
    api.get(`/agent-v2/memory/${businessId}/${leadId}`),
  listLeadMemories: (businessId: string) =>
    api.get(`/agent-v2/memories/${businessId}`),
  getRules: (businessId: string) =>
    api.get(`/agent-v2/rules/${businessId}`),
  toggleRule: (businessId: string, ruleId: string, enabled: boolean) =>
    api.patch(`/agent-v2/rules/${businessId}/${ruleId}`, { enabled }),
  deleteRule: (businessId: string, ruleId: string) =>
    api.delete(`/agent-v2/rules/${businessId}/${ruleId}`),
  generateEmbeddings: (businessId: string) =>
    api.post(`/agent-v2/embeddings/${businessId}`)
};

export const knowledgeApi = {
  list: (businessId: string) =>
    api.get(`/knowledge/${businessId}`),
  get: (businessId: string, documentId: string) =>
    api.get(`/knowledge/${businessId}/${documentId}`),
  create: (businessId: string, data: { title: string; content: string; type?: string }) =>
    api.post(`/knowledge/${businessId}`, data),
  update: (businessId: string, documentId: string, data: { title?: string; content?: string; type?: string; enabled?: boolean }) =>
    api.put(`/knowledge/${businessId}/${documentId}`, data),
  delete: (businessId: string, documentId: string) =>
    api.delete(`/knowledge/${businessId}/${documentId}`),
  search: (businessId: string, query: string, limit?: number) =>
    api.post(`/knowledge/${businessId}/search`, { query, limit })
};

export const agentFilesApi = {
  list: (businessId: string) =>
    api.get(`/agent/files/${businessId}`),
  upload: (businessId: string, formData: FormData) =>
    api.post(`/agent/files/${businessId}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    }),
  update: (businessId: string, fileId: string, data: { 
    name?: string; 
    description?: string; 
    triggerKeywords?: string; 
    triggerContext?: string; 
    order?: number; 
    enabled?: boolean 
  }) =>
    api.put(`/agent/files/${businessId}/${fileId}`, data),
  delete: (businessId: string, fileId: string) =>
    api.delete(`/agent/files/${businessId}/${fileId}`),
  reorder: (businessId: string, fileOrders: { id: string; order: number }[]) =>
    api.put(`/agent/files/${businessId}/reorder`, { fileOrders })
};

export const agentApiKeyApi = {
  get: (businessId: string) =>
    api.get(`/agent/api-key/${businessId}`),
  create: (businessId: string) =>
    api.post(`/agent/api-key/${businessId}`),
  revoke: (businessId: string) =>
    api.delete(`/agent/api-key/${businessId}`)
};

export const agentWebhookApi = {
  get: (businessId: string) =>
    api.get(`/agent/webhook/${businessId}`),
  update: (businessId: string, data: { webhookUrl: string | null; webhookEvents: string[] }) =>
    api.put(`/agent/webhook/${businessId}`, data)
};

export const advisorApi = {
  invite: (data: { email: string; businessId: string }) =>
    api.post('/advisor/invite', data),
  getInvitations: (businessId: string) =>
    api.get(`/advisor/invitations/${businessId}`),
  cancelInvitation: (id: string) =>
    api.delete(`/advisor/invitation/${id}`),
  getTeam: (businessId: string) =>
    api.get(`/advisor/team/${businessId}`),
  removeAdvisor: (advisorId: string) =>
    api.delete(`/advisor/team/${advisorId}`),
  assignContact: (data: { businessId: string; contactPhone: string; advisorId: string }) =>
    api.post('/advisor/assign', data),
  removeAssignment: (businessId: string, contactPhone: string) =>
    api.delete(`/advisor/assign/${businessId}/${encodeURIComponent(contactPhone)}`),
  getAssignments: (businessId: string) =>
    api.get(`/advisor/assignments/${businessId}`),
  getMyBusiness: () =>
    api.get('/advisor/my-business'),
  getMyContacts: (businessId: string) =>
    api.get(`/advisor/my-contacts/${businessId}`),
  getRoundRobin: (businessId: string) =>
    api.get(`/advisor/round-robin/${businessId}`),
  updateRoundRobin: (businessId: string, data: { enabled?: boolean; advisorIds?: string[] }) =>
    api.put(`/advisor/round-robin/${businessId}`, data),
  getContactInfo: (businessId: string, contactPhone: string) =>
    api.get(`/advisor/contact-info/${businessId}/${encodeURIComponent(contactPhone)}`),
  getContactOrders: (businessId: string, contactPhone: string) =>
    api.get(`/advisor/contact-orders/${businessId}/${encodeURIComponent(contactPhone)}`),
  getContactAppointments: (businessId: string, contactPhone: string) =>
    api.get(`/advisor/contact-appointments/${businessId}/${encodeURIComponent(contactPhone)}`)
};

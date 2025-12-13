'use client';

import { useState, useEffect } from 'react';
import { useBusinessStore } from '@/store/business';
import { useAuthStore } from '@/store/auth';
import { promptApi, toolsApi, businessApi, agentV2Api, agentFilesApi, agentApiKeyApi, agentWebhookApi } from '@/lib/api';
import { SkillsV2Panel, PromptsV2Panel, LeadMemoryPanel, RulesLearnedPanel, KnowledgePanel } from '@/components/AgentV2';

interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

interface DynamicVariable {
  name: string;
  description: string;
  formatExample: string;
}

interface Tool {
  id: string;
  name: string;
  description: string;
  url: string;
  method: string;
  headers: Record<string, string> | null;
  bodyTemplate: any;
  parameters: ToolParameter[] | null;
  dynamicVariables: DynamicVariable[] | null;
  enabled: boolean;
}

interface ToolLog {
  id: string;
  contactPhone: string | null;
  request: any;
  response: any;
  status: string;
  duration: number | null;
  createdAt: string;
}

interface ToolStats {
  totalCalls: number;
  avgDuration: number;
  lastCall: string | null;
}

interface V2Skills {
  search_product: boolean;
  payment: boolean;
  followup: boolean;
  media: boolean;
  crm: boolean;
}

interface V2Prompts {
  vendor: string;
  observer: string;
  refiner: string;
}

interface LeadMemory {
  leadId: string;
  phone: string;
  name?: string;
  stage?: string;
  preferences: string[];
  collectedData: Record<string, string>;
  notes: string[];
  lastInteraction?: string;
}

interface LearnedRule {
  id: string;
  rule: string;
  source: string;
  enabled: boolean;
  createdAt: string;
  appliedCount?: number;
}

interface AgentFile {
  id: string;
  name: string;
  description: string | null;
  fileUrl: string;
  fileType: string;
  triggerKeywords: string | null;
  triggerContext: string | null;
  order: number;
  enabled: boolean;
  createdAt: string;
}

const DEFAULT_PROMPT = `Eres un asistente de atencion al cliente amable y profesional.

Tu objetivo es ayudar a los clientes con sus consultas, proporcionar informacion sobre productos y servicios, y resolver cualquier problema que puedan tener.

Directrices:
- Se siempre cortes y profesional
- Responde de manera clara y concisa
- Si no sabes algo, indicalo honestamente
- Ofrece alternativas cuando sea posible
- Usa el catalogo de productos para dar informacion precisa`;

export default function PromptPage() {
  const { currentBusiness, updateBusiness } = useBusinessStore();
  const { user } = useAuthStore();
  const isPro = user?.isPro ?? false;
  const [prompt, setPrompt] = useState('');
  const [promptId, setPromptId] = useState<string | null>(null);
  const [bufferSeconds, setBufferSeconds] = useState(0);
  const [historyLimit, setHistoryLimit] = useState(10);
  const [splitMessages, setSplitMessages] = useState(true);
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [botEnabled, setBotEnabled] = useState(true);
  const [agentVersion, setAgentVersion] = useState<'v1' | 'v2'>('v1');
  const [showToolForm, setShowToolForm] = useState(false);
  const [editingTool, setEditingTool] = useState<Tool | null>(null);
  const [newTool, setNewTool] = useState({
    name: '',
    description: '',
    url: '',
    method: 'POST',
    headers: '',
    bodyTemplate: '',
    parameters: [] as ToolParameter[],
    dynamicVariables: [] as DynamicVariable[]
  });
  const [testResult, setTestResult] = useState<any>(null);
  const [showTestModal, setShowTestModal] = useState(false);
  const [testingTool, setTestingTool] = useState<Tool | null>(null);
  const [testVariables, setTestVariables] = useState<Record<string, string>>({});
  const [testLoading, setTestLoading] = useState(false);
  const [testResponse, setTestResponse] = useState<{ status?: number; data?: any; error?: string; duration?: number } | null>(null);
  const [activeTab, setActiveTab] = useState<'prompt' | 'config' | 'tools' | 'files'>('prompt');
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [selectedToolForLogs, setSelectedToolForLogs] = useState<Tool | null>(null);
  const [toolLogs, setToolLogs] = useState<ToolLog[]>([]);
  const [toolStats, setToolStats] = useState<ToolStats | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const [v2Skills, setV2Skills] = useState<V2Skills>({
    search_product: true,
    payment: true,
    followup: true,
    media: true,
    crm: true
  });
  const [v2Prompts, setV2Prompts] = useState<V2Prompts>({
    vendor: '',
    observer: '',
    refiner: ''
  });
  const [leadMemories, setLeadMemories] = useState<LeadMemory[]>([]);
  const [learnedRules, setLearnedRules] = useState<LearnedRule[]>([]);
  const [loadingV2, setLoadingV2] = useState(false);
  const [activeV2Tab, setActiveV2Tab] = useState<'prompt' | 'skills' | 'prompts' | 'memory' | 'rules' | 'knowledge' | 'tools' | 'config' | 'api'>('prompt');
  
  const [apiKeyInfo, setApiKeyInfo] = useState<{ hasApiKey: boolean; prefix: string | null; createdAt: string | null } | null>(null);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [webhookConfig, setWebhookConfig] = useState<{ webhookUrl: string | null; webhookEvents: string[]; webhookSecret: string | null; availableEvents: string[] } | null>(null);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [loadingApiKey, setLoadingApiKey] = useState(false);
  const [loadingWebhook, setLoadingWebhook] = useState(false);
  
  const [agentFiles, setAgentFiles] = useState<AgentFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [showFileForm, setShowFileForm] = useState(false);
  const [editingFile, setEditingFile] = useState<AgentFile | null>(null);
  const [newFile, setNewFile] = useState({
    name: '',
    description: '',
    triggerKeywords: '',
    triggerContext: ''
  });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  
  const [injectionCode, setInjectionCode] = useState<string | null>(null);
  const [gptUrl, setGptUrl] = useState<string | null>(null);
  const [loadingInjection, setLoadingInjection] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    if (currentBusiness) {
      setBotEnabled(currentBusiness.botEnabled);
      const version = (currentBusiness as any).agentVersion || 'v1';
      setAgentVersion(version);
      loadData();
      loadAgentFiles();
      loadInjectionCode();
      if (version === 'v2') {
        loadV2Data();
      }
    }
  }, [currentBusiness]);

  useEffect(() => {
    if (currentBusiness && agentVersion === 'v2') {
      loadV2Data();
      loadApiKeyInfo();
      loadWebhookConfig();
    }
  }, [agentVersion]);

  const loadApiKeyInfo = async () => {
    if (!currentBusiness) return;
    try {
      const res = await agentApiKeyApi.get(currentBusiness.id);
      setApiKeyInfo(res.data);
    } catch (err) {
      console.error('Error loading API key info:', err);
    }
  };

  const loadWebhookConfig = async () => {
    if (!currentBusiness) return;
    try {
      const res = await agentWebhookApi.get(currentBusiness.id);
      setWebhookConfig(res.data);
      setWebhookUrl(res.data.webhookUrl || '');
      setSelectedEvents(res.data.webhookEvents || []);
    } catch (err) {
      console.error('Error loading webhook config:', err);
    }
  };

  const handleGenerateApiKey = async () => {
    if (!currentBusiness) return;
    if (apiKeyInfo?.hasApiKey && !confirm('Esto revocara la API key actual y generara una nueva. Continuar?')) return;
    
    setLoadingApiKey(true);
    setError('');
    try {
      const res = await agentApiKeyApi.create(currentBusiness.id);
      setNewApiKey(res.data.apiKey);
      setApiKeyInfo({ hasApiKey: true, prefix: res.data.prefix, createdAt: res.data.createdAt });
      setSuccess('API key generada. Guardala ahora, no podras verla de nuevo.');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al generar API key');
    } finally {
      setLoadingApiKey(false);
    }
  };

  const handleRevokeApiKey = async () => {
    if (!currentBusiness || !confirm('Esto revocara la API key. Las integraciones que la usen dejaran de funcionar. Continuar?')) return;
    
    setLoadingApiKey(true);
    setError('');
    try {
      await agentApiKeyApi.revoke(currentBusiness.id);
      setApiKeyInfo({ hasApiKey: false, prefix: null, createdAt: null });
      setNewApiKey(null);
      setSuccess('API key revocada');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al revocar API key');
    } finally {
      setLoadingApiKey(false);
    }
  };

  const handleSaveWebhook = async () => {
    if (!currentBusiness) return;
    
    setLoadingWebhook(true);
    setError('');
    try {
      const res = await agentWebhookApi.update(currentBusiness.id, {
        webhookUrl: webhookUrl || null,
        webhookEvents: selectedEvents
      });
      setWebhookConfig(res.data);
      setSuccess('Webhook configurado correctamente');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al configurar webhook');
    } finally {
      setLoadingWebhook(false);
    }
  };

  const handleToggleEvent = (event: string) => {
    setSelectedEvents(prev => 
      prev.includes(event) ? prev.filter(e => e !== event) : [...prev, event]
    );
  };

  const loadData = async () => {
    if (!currentBusiness) return;
    
    try {
      const res = await promptApi.get(currentBusiness.id);
      if (res.data) {
        setPrompt(res.data.prompt);
        setPromptId(res.data.id);
        setBufferSeconds(res.data.bufferSeconds || 0);
        setHistoryLimit(res.data.historyLimit || 10);
        setSplitMessages(res.data.splitMessages ?? true);
        setTools(res.data.tools || []);
      } else {
        setPrompt(DEFAULT_PROMPT);
      }
    } catch {
      setPrompt(DEFAULT_PROMPT);
    }
  };

  const loadAgentFiles = async () => {
    if (!currentBusiness) return;
    
    setLoadingFiles(true);
    try {
      const res = await agentFilesApi.list(currentBusiness.id);
      setAgentFiles(res.data.files || []);
    } catch (err) {
      console.error('Error loading agent files:', err);
    } finally {
      setLoadingFiles(false);
    }
  };

  const loadInjectionCode = async () => {
    if (!currentBusiness) return;
    
    try {
      const res = await businessApi.getInjectionCode(currentBusiness.id);
      setInjectionCode(res.data.injectionCode);
      setGptUrl(res.data.gptUrl);
    } catch (err) {
      console.error('Error loading injection code:', err);
    }
  };

  const handleGenerateCode = async () => {
    if (!currentBusiness) return;
    
    setLoadingInjection(true);
    try {
      const res = await businessApi.generateInjectionCode(currentBusiness.id);
      setInjectionCode(res.data.injectionCode);
      setGptUrl(res.data.gptUrl);
      setSuccess('Codigo generado correctamente');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al generar codigo');
    } finally {
      setLoadingInjection(false);
    }
  };

  const handleCopyCode = () => {
    if (injectionCode) {
      navigator.clipboard.writeText(injectionCode);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  const handleUploadFile = async () => {
    if (!currentBusiness || !selectedFile) return;
    
    setUploadingFile(true);
    setError('');
    
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('name', newFile.name || selectedFile.name);
      formData.append('description', newFile.description);
      formData.append('triggerKeywords', newFile.triggerKeywords);
      formData.append('triggerContext', newFile.triggerContext);
      
      await agentFilesApi.upload(currentBusiness.id, formData);
      setSuccess('Archivo subido correctamente');
      setShowFileForm(false);
      setSelectedFile(null);
      setNewFile({ name: '', description: '', triggerKeywords: '', triggerContext: '' });
      loadAgentFiles();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al subir archivo');
    } finally {
      setUploadingFile(false);
    }
  };

  const handleUpdateFile = async (fileId: string, data: Partial<AgentFile>) => {
    if (!currentBusiness) return;
    
    try {
      const cleanData: { name?: string; description?: string; triggerKeywords?: string; triggerContext?: string; order?: number; enabled?: boolean } = {};
      if (data.name !== undefined && data.name !== null) cleanData.name = data.name;
      if (data.description !== undefined && data.description !== null) cleanData.description = data.description;
      if (data.triggerKeywords !== undefined && data.triggerKeywords !== null) cleanData.triggerKeywords = data.triggerKeywords;
      if (data.triggerContext !== undefined && data.triggerContext !== null) cleanData.triggerContext = data.triggerContext;
      if (data.order !== undefined) cleanData.order = data.order;
      if (data.enabled !== undefined) cleanData.enabled = data.enabled;
      
      await agentFilesApi.update(currentBusiness.id, fileId, cleanData);
      setSuccess('Archivo actualizado');
      loadAgentFiles();
      setEditingFile(null);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al actualizar archivo');
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    if (!currentBusiness || !confirm('¿Eliminar este archivo?')) return;
    
    try {
      await agentFilesApi.delete(currentBusiness.id, fileId);
      setSuccess('Archivo eliminado');
      loadAgentFiles();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al eliminar archivo');
    }
  };

  const handleMoveFile = async (fileId: string, direction: 'up' | 'down') => {
    const idx = agentFiles.findIndex(f => f.id === fileId);
    if (idx === -1) return;
    
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= agentFiles.length) return;
    
    const newFiles = [...agentFiles];
    [newFiles[idx], newFiles[newIdx]] = [newFiles[newIdx], newFiles[idx]];
    
    const fileOrders = newFiles.map((f, i) => ({ id: f.id, order: i }));
    
    try {
      await agentFilesApi.reorder(currentBusiness!.id, fileOrders);
      setAgentFiles(newFiles);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al reordenar');
    }
  };

  const loadV2Data = async () => {
    if (!currentBusiness) return;
    
    setLoadingV2(true);
    try {
      const [configRes, memoriesRes, rulesRes] = await Promise.allSettled([
        agentV2Api.getConfig(currentBusiness.id),
        agentV2Api.listLeadMemories(currentBusiness.id),
        agentV2Api.getRules(currentBusiness.id)
      ]);

      if (configRes.status === 'fulfilled' && configRes.value.data) {
        const config = configRes.value.data;
        if (config.skills) setV2Skills(config.skills);
        if (config.prompts) setV2Prompts(config.prompts);
      }

      if (memoriesRes.status === 'fulfilled' && memoriesRes.value.data) {
        setLeadMemories(memoriesRes.value.data.memories || []);
      }

      if (rulesRes.status === 'fulfilled' && rulesRes.value.data) {
        setLearnedRules(rulesRes.value.data.rules || []);
      }
    } catch (err) {
      console.error('Error loading V2 data:', err);
    } finally {
      setLoadingV2(false);
    }
  };

  const handleToggleV2Skill = async (skill: keyof V2Skills) => {
    if (!currentBusiness) return;
    
    const newSkills = { ...v2Skills, [skill]: !v2Skills[skill] };
    setV2Skills(newSkills);
    
    try {
      await agentV2Api.saveConfig(currentBusiness.id, { skills: newSkills });
      setSuccess(`Skill ${skill} ${newSkills[skill] ? 'activado' : 'desactivado'}`);
    } catch (err: any) {
      setV2Skills(v2Skills);
      setError(err.response?.data?.error || 'Error al actualizar skill');
    }
  };

  const handleSaveV2Prompts = async (prompts: V2Prompts) => {
    if (!currentBusiness) return;
    
    setLoading(true);
    setError('');
    
    try {
      await agentV2Api.saveConfig(currentBusiness.id, { prompts });
      setV2Prompts(prompts);
      setSuccess('Prompts de V2 guardados correctamente');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al guardar prompts');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleRule = async (ruleId: string, enabled: boolean) => {
    if (!currentBusiness) return;
    
    try {
      await agentV2Api.toggleRule(currentBusiness.id, ruleId, enabled);
      setLearnedRules(rules => 
        rules.map(r => r.id === ruleId ? { ...r, enabled } : r)
      );
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al actualizar regla');
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!currentBusiness) return;
    
    try {
      await agentV2Api.deleteRule(currentBusiness.id, ruleId);
      setLearnedRules(rules => rules.filter(r => r.id !== ruleId));
      setSuccess('Regla eliminada');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al eliminar regla');
    }
  };

  const handleRefreshMemories = async () => {
    if (!currentBusiness) return;
    
    setLoadingV2(true);
    try {
      const res = await agentV2Api.listLeadMemories(currentBusiness.id);
      setLeadMemories(res.data.memories || []);
    } catch (err) {
      console.error('Error refreshing memories:', err);
    } finally {
      setLoadingV2(false);
    }
  };

  const handleRefreshRules = async () => {
    if (!currentBusiness) return;
    
    setLoadingV2(true);
    try {
      const res = await agentV2Api.getRules(currentBusiness.id);
      setLearnedRules(res.data.rules || []);
    } catch (err) {
      console.error('Error refreshing rules:', err);
    } finally {
      setLoadingV2(false);
    }
  };

  const handleSavePrompt = async () => {
    if (!currentBusiness) return;
    
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const response = await promptApi.save({
        businessId: currentBusiness.id,
        prompt,
        bufferSeconds,
        historyLimit,
        splitMessages
      });
      setPromptId(response.data.id);
      setSuccess('Configuracion guardada correctamente');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al guardar');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleBot = async () => {
    if (!currentBusiness) return;
    
    setLoading(true);
    setError('');

    try {
      const response = await businessApi.toggleBot(currentBusiness.id, !botEnabled);
      setBotEnabled(response.data.botEnabled);
      updateBusiness(currentBusiness.id, { botEnabled: response.data.botEnabled });
      setSuccess(`Bot ${response.data.botEnabled ? 'activado' : 'desactivado'}`);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al cambiar estado del bot');
    } finally {
      setLoading(false);
    }
  };

  const handleChangeAgentVersion = async (version: 'v1' | 'v2') => {
    if (!currentBusiness || version === agentVersion) return;
    
    if (version === 'v2' && !isPro) {
      setError('El Agente V2 solo esta disponible para usuarios Pro. Contacta a soporte para actualizar tu plan.');
      return;
    }
    
    setLoading(true);
    setError('');

    try {
      await businessApi.update(currentBusiness.id, { agentVersion: version });
      setAgentVersion(version);
      updateBusiness(currentBusiness.id, { agentVersion: version } as any);
      setSuccess(`Cambiado a Agente ${version.toUpperCase()}`);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al cambiar version del agente');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateTool = async () => {
    if (!currentBusiness) return;
    
    setLoading(true);
    setError('');

    try {
      let headers = null;
      let bodyTemplate = null;
      
      if (newTool.headers) {
        try {
          headers = JSON.parse(newTool.headers);
        } catch {
          setError('Headers debe ser JSON valido');
          setLoading(false);
          return;
        }
      }
      
      if (newTool.bodyTemplate) {
        try {
          bodyTemplate = JSON.parse(newTool.bodyTemplate);
        } catch {
          setError('Body Template debe ser JSON valido');
          setLoading(false);
          return;
        }
      }

      await toolsApi.create({
        business_id: currentBusiness.id,
        name: newTool.name,
        description: newTool.description,
        url: newTool.url,
        method: newTool.method,
        headers: headers || undefined,
        bodyTemplate: bodyTemplate || undefined,
        parameters: newTool.parameters.length > 0 ? newTool.parameters : undefined,
        dynamicVariables: newTool.dynamicVariables.length > 0 ? newTool.dynamicVariables : undefined
      });
      
      setShowToolForm(false);
      setNewTool({ name: '', description: '', url: '', method: 'POST', headers: '', bodyTemplate: '', parameters: [], dynamicVariables: [] });
      loadData();
      setSuccess('Tool creado correctamente');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al crear tool');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteTool = async (id: string) => {
    if (!confirm('Estas seguro de eliminar este tool?')) return;
    
    try {
      await toolsApi.delete(id);
      setTools(tools.filter(t => t.id !== id));
      setSuccess('Tool eliminado');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al eliminar');
    }
  };

  const handleToggleTool = async (tool: Tool) => {
    try {
      await toolsApi.update(tool.id, { enabled: !tool.enabled });
      setTools(tools.map(t => t.id === tool.id ? { ...t, enabled: !t.enabled } : t));
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al actualizar');
    }
  };

  const handleEditTool = (tool: Tool) => {
    setEditingTool(tool);
    setNewTool({
      name: tool.name,
      description: tool.description,
      url: tool.url,
      method: tool.method,
      headers: tool.headers ? JSON.stringify(tool.headers) : '',
      bodyTemplate: tool.bodyTemplate ? JSON.stringify(tool.bodyTemplate, null, 2) : '',
      parameters: tool.parameters || [],
      dynamicVariables: tool.dynamicVariables || []
    });
    setShowToolForm(true);
  };

  const handleUpdateTool = async () => {
    if (!editingTool) return;
    
    setLoading(true);
    setError('');

    try {
      let headers = null;
      let bodyTemplate = null;
      
      if (newTool.headers) {
        try {
          headers = JSON.parse(newTool.headers);
        } catch {
          setError('Headers debe ser JSON valido');
          setLoading(false);
          return;
        }
      }
      
      if (newTool.bodyTemplate) {
        try {
          bodyTemplate = JSON.parse(newTool.bodyTemplate);
        } catch {
          setError('Body Template debe ser JSON valido');
          setLoading(false);
          return;
        }
      }

      await toolsApi.update(editingTool.id, {
        name: newTool.name,
        description: newTool.description,
        url: newTool.url,
        method: newTool.method,
        headers: headers || undefined,
        bodyTemplate: bodyTemplate || undefined,
        parameters: newTool.parameters.length > 0 ? newTool.parameters : null,
        dynamicVariables: newTool.dynamicVariables.length > 0 ? newTool.dynamicVariables : null
      });
      
      setShowToolForm(false);
      setEditingTool(null);
      setNewTool({ name: '', description: '', url: '', method: 'POST', headers: '', bodyTemplate: '', parameters: [], dynamicVariables: [] });
      loadData();
      setSuccess('Tool actualizado correctamente');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al actualizar tool');
    } finally {
      setLoading(false);
    }
  };

  const handleCancelToolForm = () => {
    setShowToolForm(false);
    setEditingTool(null);
    setNewTool({ name: '', description: '', url: '', method: 'POST', headers: '', bodyTemplate: '', parameters: [], dynamicVariables: [] });
  };

  const handleViewLogs = async (tool: Tool) => {
    setSelectedToolForLogs(tool);
    setLoadingLogs(true);
    setShowLogsModal(true);
    
    try {
      const [logsRes, statsRes] = await Promise.all([
        toolsApi.logs(tool.id, 50, 0),
        toolsApi.stats(tool.id)
      ]);
      setToolLogs(logsRes.data.logs || []);
      setToolStats(statsRes.data);
    } catch (err) {
      console.error('Failed to load tool logs:', err);
      setToolLogs([]);
      setToolStats(null);
    } finally {
      setLoadingLogs(false);
    }
  };

  const handleCloseLogsModal = () => {
    setShowLogsModal(false);
    setSelectedToolForLogs(null);
    setToolLogs([]);
    setToolStats(null);
  };

  const extractVariablesFromTool = (tool: Tool): string[] => {
    const variables = new Set<string>();
    const regex = /\{\{(\w+)\}\}/g;
    
    if (tool.url) {
      let match;
      while ((match = regex.exec(tool.url)) !== null) {
        variables.add(match[1]);
      }
    }
    
    if (tool.headers) {
      const headersStr = JSON.stringify(tool.headers);
      let match;
      regex.lastIndex = 0;
      while ((match = regex.exec(headersStr)) !== null) {
        variables.add(match[1]);
      }
    }
    
    if (tool.bodyTemplate) {
      const bodyStr = JSON.stringify(tool.bodyTemplate);
      let match;
      regex.lastIndex = 0;
      while ((match = regex.exec(bodyStr)) !== null) {
        variables.add(match[1]);
      }
    }
    
    if (tool.dynamicVariables) {
      tool.dynamicVariables.forEach(v => variables.add(v.name));
    }
    
    return Array.from(variables);
  };

  const handleOpenTestModal = (tool: Tool) => {
    const vars = extractVariablesFromTool(tool);
    const initialVars: Record<string, string> = {};
    vars.forEach(v => { initialVars[v] = ''; });
    
    setTestingTool(tool);
    setTestVariables(initialVars);
    setTestResponse(null);
    setShowTestModal(true);
  };

  const handleCloseTestModal = () => {
    setShowTestModal(false);
    setTestingTool(null);
    setTestVariables({});
    setTestResponse(null);
  };

  const interpolateTestString = (template: string, vars: Record<string, string>): string => {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || '');
  };

  const interpolateTestValue = (value: any, vars: Record<string, string>): any => {
    if (typeof value === 'string') {
      return interpolateTestString(value, vars);
    }
    if (Array.isArray(value)) {
      return value.map(item => interpolateTestValue(item, vars));
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = interpolateTestValue(v, vars);
      }
      return result;
    }
    return value;
  };

  const handleExecuteTest = async () => {
    if (!testingTool) return;
    
    setTestLoading(true);
    setTestResponse(null);
    
    const startTime = Date.now();
    
    try {
      const url = interpolateTestString(testingTool.url, testVariables);
      
      let headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (testingTool.headers) {
        const interpolatedHeaders = interpolateTestValue(testingTool.headers, testVariables);
        headers = { ...headers, ...interpolatedHeaders };
      }
      
      const fetchOptions: RequestInit = {
        method: testingTool.method,
        headers
      };
      
      if (testingTool.method !== 'GET' && testingTool.bodyTemplate) {
        const body = interpolateTestValue(testingTool.bodyTemplate, testVariables);
        fetchOptions.body = JSON.stringify(body);
      }
      
      const response = await fetch(url, fetchOptions);
      const duration = Date.now() - startTime;
      
      let data;
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }
      
      setTestResponse({
        status: response.status,
        data,
        duration
      });
    } catch (err: any) {
      setTestResponse({
        error: err.message || 'Error de conexion',
        duration: Date.now() - startTime
      });
    } finally {
      setTestLoading(false);
    }
  };

  const handleTestTool = async (tool: Tool) => {
    setTestResult(null);
    try {
      const res = await toolsApi.test(tool.id, { query: 'test' });
      setTestResult({ toolId: tool.id, ...res.data });
    } catch (err: any) {
      setTestResult({ toolId: tool.id, error: err.message });
    }
  };

  if (!currentBusiness) {
    return (
      <div className="card text-center py-12">
        <p className="text-gray-400">
          Primero debes crear una empresa para configurar el agente IA.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl p-4 sm:p-0">
      <h1 className="text-xl sm:text-2xl font-bold text-white mb-6">Agente IA</h1>

      {success && (
        <div className="bg-accent-success/10 border border-accent-success/20 text-accent-success px-4 py-3 rounded-lg mb-4">
          {success}
        </div>
      )}
      {error && (
        <div className="bg-accent-error/10 border border-accent-error/20 text-accent-error px-4 py-3 rounded-lg mb-4">
          {error}
        </div>
      )}

      <div className="card mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Estado del Bot</h2>
            <p className="text-sm text-gray-400">
              {botEnabled 
                ? 'El bot respondera automaticamente a los mensajes'
                : 'Los mensajes se registraran pero no habra respuesta automatica'}
            </p>
          </div>
          <button
            onClick={handleToggleBot}
            disabled={loading}
            className={`px-6 py-3 rounded-full font-medium transition-colors ${
              botEnabled
                ? 'bg-accent-success text-white hover:bg-green-600'
                : 'bg-dark-hover text-gray-400 hover:bg-gray-600'
            }`}
          >
            {botEnabled ? 'Activo' : 'Inactivo'}
          </button>
        </div>
      </div>

      <div className="card mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Version del Agente</h2>
            <p className="text-sm text-gray-400">
              {agentVersion === 'v1' 
                ? 'Agente Clasico - Respuestas directas con OpenAI'
                : 'Agente Avanzado - Procesamiento con LangGraph y memoria mejorada'}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handleChangeAgentVersion('v1')}
              disabled={loading}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                agentVersion === 'v1'
                  ? 'bg-neon-blue text-dark-bg'
                  : 'bg-dark-hover text-gray-400 hover:text-white'
              }`}
            >
              V1 Clasico
            </button>
            <button
              onClick={() => handleChangeAgentVersion('v2')}
              disabled={loading || (!isPro && agentVersion !== 'v2')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                agentVersion === 'v2'
                  ? 'bg-neon-purple text-white'
                  : !isPro 
                    ? 'bg-dark-hover/50 text-gray-500 cursor-not-allowed'
                    : 'bg-dark-hover text-gray-400 hover:text-white'
              }`}
            >
              V2 Avanzado
              {!isPro && agentVersion !== 'v2' && (
                <span className="text-xs bg-neon-purple/30 text-neon-purple px-2 py-0.5 rounded-full">PRO</span>
              )}
            </button>
          </div>
        </div>
        {agentVersion === 'v2' && (
          <div className="mt-4 p-3 bg-neon-purple/10 border border-neon-purple/20 rounded-lg">
            <p className="text-sm text-neon-purple">
              El Agente V2 usa procesamiento avanzado con LangGraph para respuestas mas contextuales y memoria mejorada.
            </p>
          </div>
        )}
        {!isPro && agentVersion !== 'v2' && (
          <div className="mt-4 p-3 bg-gray-800/50 border border-gray-700 rounded-lg">
            <p className="text-sm text-gray-400">
              El Agente V2 Avanzado solo esta disponible para usuarios Pro. Contacta a soporte para actualizar tu plan.
            </p>
          </div>
        )}
      </div>

      {agentVersion === 'v1' ? (
        <div className="flex flex-wrap gap-2 mb-6">
          <button
            onClick={() => setActiveTab('prompt')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'prompt' ? 'bg-neon-blue text-dark-bg' : 'bg-dark-card text-gray-400 hover:text-white'
            }`}
          >
            Prompt Maestro
          </button>
          <button
            onClick={() => setActiveTab('config')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'config' ? 'bg-neon-blue text-dark-bg' : 'bg-dark-card text-gray-400 hover:text-white'
            }`}
          >
            Configuracion
          </button>
          <button
            onClick={() => setActiveTab('files')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'files' ? 'bg-neon-blue text-dark-bg' : 'bg-dark-card text-gray-400 hover:text-white'
            }`}
          >
            Archivos
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 mb-6">
          <button
            onClick={() => setActiveV2Tab('prompt')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeV2Tab === 'prompt' ? 'bg-neon-purple text-white' : 'bg-dark-card text-gray-400 hover:text-white'
            }`}
          >
            Prompt Maestro
          </button>
          <button
            onClick={() => setActiveV2Tab('skills')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeV2Tab === 'skills' ? 'bg-neon-purple text-white' : 'bg-dark-card text-gray-400 hover:text-white'
            }`}
          >
            Skills V2
          </button>
          <button
            onClick={() => setActiveV2Tab('prompts')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeV2Tab === 'prompts' ? 'bg-neon-purple text-white' : 'bg-dark-card text-gray-400 hover:text-white'
            }`}
          >
            3 Cerebros
          </button>
          <button
            onClick={() => setActiveV2Tab('memory')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeV2Tab === 'memory' ? 'bg-neon-purple text-white' : 'bg-dark-card text-gray-400 hover:text-white'
            }`}
          >
            Memoria
          </button>
          <button
            onClick={() => setActiveV2Tab('rules')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeV2Tab === 'rules' ? 'bg-neon-purple text-white' : 'bg-dark-card text-gray-400 hover:text-white'
            }`}
          >
            Reglas ({learnedRules.length})
          </button>
          <button
            onClick={() => setActiveV2Tab('knowledge')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeV2Tab === 'knowledge' ? 'bg-neon-purple text-white' : 'bg-dark-card text-gray-400 hover:text-white'
            }`}
          >
            Conocimiento
          </button>
          <button
            onClick={() => setActiveV2Tab('tools')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeV2Tab === 'tools' ? 'bg-neon-purple text-white' : 'bg-dark-card text-gray-400 hover:text-white'
            }`}
          >
            Tools ({tools.length})
          </button>
          <button
            onClick={() => {
              setActiveV2Tab('config');
              setActiveTab('config');
            }}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeV2Tab === 'config' ? 'bg-neon-purple text-white' : 'bg-dark-card text-gray-400 hover:text-white'
            }`}
          >
            Configuracion
          </button>
          <button
            onClick={() => setActiveV2Tab('api')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeV2Tab === 'api' ? 'bg-neon-purple text-white' : 'bg-dark-card text-gray-400 hover:text-white'
            }`}
          >
            API & Webhooks
          </button>
        </div>
      )}

      {agentVersion === 'v2' && activeV2Tab === 'prompt' && (
        <div className="card">
          <h2 className="text-lg font-semibold text-white mb-2">Prompt Maestro</h2>
          <p className="text-sm text-gray-400 mb-4">
            El prompt base que define la personalidad y comportamiento de tu agente. 
            V2 tambien usa este prompt como contexto principal.
          </p>
          
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="input font-mono text-sm resize-none"
            rows={15}
            placeholder="Escribe las instrucciones para tu agente IA..."
          />

          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mt-4">
            <button
              onClick={() => setPrompt(DEFAULT_PROMPT)}
              className="btn btn-secondary w-full sm:w-auto"
            >
              Restaurar por defecto
            </button>
            <button
              onClick={handleSavePrompt}
              disabled={loading || !prompt}
              className="btn btn-primary w-full sm:w-auto"
            >
              {loading ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </div>
      )}

      {agentVersion === 'v2' && activeV2Tab === 'skills' && (
        <SkillsV2Panel
          skills={v2Skills}
          onToggleSkill={handleToggleV2Skill}
          loading={loadingV2}
        />
      )}

      {agentVersion === 'v2' && activeV2Tab === 'prompts' && (
        <PromptsV2Panel
          prompts={v2Prompts}
          onUpdatePrompts={handleSaveV2Prompts}
          loading={loading}
        />
      )}

      {agentVersion === 'v2' && activeV2Tab === 'memory' && (
        <LeadMemoryPanel
          memories={leadMemories}
          loading={loadingV2}
          onRefresh={handleRefreshMemories}
        />
      )}

      {agentVersion === 'v2' && activeV2Tab === 'rules' && (
        <RulesLearnedPanel
          rules={learnedRules}
          loading={loadingV2}
          onToggleRule={handleToggleRule}
          onDeleteRule={handleDeleteRule}
          onRefresh={handleRefreshRules}
        />
      )}

      {agentVersion === 'v2' && activeV2Tab === 'knowledge' && (
        <KnowledgePanel businessId={currentBusiness.id} />
      )}

      {agentVersion === 'v1' && activeTab === 'prompt' && (
        <div className="space-y-4">
          <div className="card bg-gradient-to-r from-neon-blue/10 to-purple-500/10 border-neon-blue/30">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h3 className="text-white font-semibold flex items-center gap-2">
                  <svg className="w-5 h-5 text-neon-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  Configuracion con IA
                </h3>
                <p className="text-sm text-gray-400 mt-1">
                  Usa nuestro GPT asistente para configurar tu prompt automaticamente.
                </p>
              </div>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
                {injectionCode ? (
                  <>
                    <div className="flex items-center gap-2 bg-dark-bg rounded-lg px-3 py-2">
                      <span className="text-gray-400 text-sm">Codigo:</span>
                      <span className="font-mono text-neon-blue font-bold tracking-wider">{injectionCode}</span>
                      <button
                        onClick={handleCopyCode}
                        className="ml-2 text-gray-400 hover:text-white transition-colors"
                        title="Copiar codigo"
                      >
                        {copiedCode ? (
                          <svg className="w-4 h-4 text-accent-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        )}
                      </button>
                    </div>
                    {gptUrl && (
                      <a
                        href={gptUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-primary text-center"
                      >
                        Ir al GPT
                      </a>
                    )}
                  </>
                ) : (
                  <button
                    onClick={handleGenerateCode}
                    disabled={loadingInjection}
                    className="btn btn-primary"
                  >
                    {loadingInjection ? 'Generando...' : 'Generar codigo de acceso'}
                  </button>
                )}
              </div>
            </div>
            {injectionCode && (
              <p className="text-xs text-gray-500 mt-3 border-t border-dark-border pt-3">
                Copia el codigo y ve al GPT. Cuando el GPT te pida tus datos, ingresa tu email y este codigo para verificar tu identidad.
              </p>
            )}
          </div>

          <div className="card">
            <h2 className="text-lg font-semibold text-white mb-4">Prompt maestro</h2>
            <p className="text-sm text-gray-400 mb-4">
              Este es el prompt que define como se comporta tu agente de IA. 
              El contexto de productos y politicas se anadira automaticamente.
            </p>
            
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="input font-mono text-sm resize-none"
              rows={15}
              placeholder="Escribe las instrucciones para tu agente IA..."
            />

            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mt-4">
              <button
                onClick={() => setPrompt(DEFAULT_PROMPT)}
                className="btn btn-secondary w-full sm:w-auto"
              >
                Restaurar por defecto
              </button>
              <button
                onClick={handleSavePrompt}
                disabled={loading || !prompt}
                className="btn btn-primary w-full sm:w-auto"
              >
                {loading ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {((agentVersion === 'v1' && activeTab === 'config') || (agentVersion === 'v2' && activeV2Tab === 'config')) && (
        <div className="space-y-6">
          <div className="card">
            <h2 className="text-lg font-semibold text-white mb-4">Buffer de Mensajes</h2>
            <p className="text-sm text-gray-400 mb-4">
              Tiempo de espera para acumular mensajes antes de que el agente responda.
              Util cuando el usuario envia varios mensajes seguidos.
            </p>
            
            <div className="flex items-center gap-4">
              <input
                type="range"
                min="0"
                max="30"
                value={bufferSeconds}
                onChange={(e) => setBufferSeconds(parseInt(e.target.value))}
                className="flex-1 accent-neon-blue"
              />
              <span className="font-mono text-lg w-20 text-center text-white">
                {bufferSeconds}s
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {bufferSeconds === 0 
                ? 'Sin buffer - respuesta inmediata' 
                : `Espera ${bufferSeconds} segundos para acumular mensajes`}
            </p>
          </div>

          <div className="card">
            <h2 className="text-lg font-semibold text-white mb-4">Historial de Conversacion</h2>
            <p className="text-sm text-gray-400 mb-4">
              Cantidad de mensajes anteriores que el agente recuerda para dar contexto.
            </p>
            
            <div className="flex items-center gap-4">
              <input
                type="range"
                min="5"
                max="50"
                value={historyLimit}
                onChange={(e) => setHistoryLimit(parseInt(e.target.value))}
                className="flex-1 accent-neon-blue"
              />
              <span className="font-mono text-lg w-20 text-center text-white">
                {historyLimit}
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              El agente recordara los ultimos {historyLimit} mensajes de la conversacion
            </p>
          </div>

          <div className="card">
            <h2 className="text-lg font-semibold text-white mb-4">Division de Mensajes</h2>
            <p className="text-sm text-gray-400 mb-4">
              Dividir respuestas largas en multiples mensajes para parecer mas humano.
            </p>
            
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={splitMessages}
                onChange={(e) => setSplitMessages(e.target.checked)}
                className="w-5 h-5 rounded border-gray-600 bg-dark-hover text-neon-blue focus:ring-neon-blue"
              />
              <span className="text-gray-300">
                Dividir respuestas por parrafos
              </span>
            </label>
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleSavePrompt}
              disabled={loading}
              className="btn btn-primary"
            >
              {loading ? 'Guardando...' : 'Guardar Configuracion'}
            </button>
          </div>
        </div>
      )}

      {agentVersion === 'v1' && activeTab === 'files' && (
        <div className="space-y-6">
          <div className="card">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Archivos del Agente</h2>
                <p className="text-sm text-gray-400">
                  Sube documentos, fotos o archivos que el agente puede enviar automaticamente segun el contexto de la conversacion.
                </p>
              </div>
              {!showFileForm && (
                <button
                  onClick={() => setShowFileForm(true)}
                  className="btn btn-primary w-full sm:w-auto"
                >
                  + Subir Archivo
                </button>
              )}
            </div>

            {showFileForm && (
              <div className="border border-dark-hover rounded-lg p-4 mb-4 space-y-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-white">Nuevo Archivo</h3>
                  <button
                    onClick={() => { setShowFileForm(false); setSelectedFile(null); setNewFile({ name: '', description: '', triggerKeywords: '', triggerContext: '' }); }}
                    className="text-sm text-gray-400 hover:text-white"
                  >
                    Cancelar
                  </button>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Archivo</label>
                  <input
                    type="file"
                    onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                    accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                    className="w-full text-sm text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-dark-hover file:text-white hover:file:bg-neon-blue/20"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Nombre (opcional)</label>
                  <input
                    type="text"
                    value={newFile.name}
                    onChange={(e) => setNewFile({ ...newFile, name: e.target.value })}
                    placeholder="Nombre descriptivo del archivo"
                    className="input"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Descripcion</label>
                  <textarea
                    value={newFile.description}
                    onChange={(e) => setNewFile({ ...newFile, description: e.target.value })}
                    placeholder="Describe el contenido del archivo para que el agente sepa cuando usarlo"
                    className="input resize-none"
                    rows={2}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Palabras Clave de Activacion</label>
                  <input
                    type="text"
                    value={newFile.triggerKeywords}
                    onChange={(e) => setNewFile({ ...newFile, triggerKeywords: e.target.value })}
                    placeholder="planos, triptico, catalogo, precios (separadas por comas)"
                    className="input"
                  />
                  <p className="text-xs text-gray-500 mt-1">Palabras que el cliente debe mencionar para que el agente envie este archivo</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Contexto de Envio</label>
                  <textarea
                    value={newFile.triggerContext}
                    onChange={(e) => setNewFile({ ...newFile, triggerContext: e.target.value })}
                    placeholder="Ej: Cuando el cliente pregunte por los planos de departamentos o quiera ver opciones disponibles"
                    className="input resize-none"
                    rows={2}
                  />
                  <p className="text-xs text-gray-500 mt-1">Describe el contexto o situacion en que el agente debe enviar este archivo</p>
                </div>

                <button
                  onClick={handleUploadFile}
                  disabled={uploadingFile || !selectedFile}
                  className="btn btn-primary w-full"
                >
                  {uploadingFile ? 'Subiendo...' : 'Subir Archivo'}
                </button>
              </div>
            )}

            {loadingFiles ? (
              <div className="flex justify-center py-8">
                <div className="w-8 h-8 border-2 border-neon-blue border-t-transparent rounded-full animate-spin" />
              </div>
            ) : agentFiles.length === 0 ? (
              <div className="text-center py-8 text-gray-400">
                <svg className="w-12 h-12 mx-auto mb-3 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                <p>No hay archivos configurados</p>
                <p className="text-sm text-gray-500 mt-1">Sube archivos que el agente pueda enviar a tus clientes</p>
              </div>
            ) : (
              <div className="space-y-3">
                {agentFiles.map((file, idx) => (
                  <div key={file.id} className={`border rounded-lg p-4 ${file.enabled ? 'border-dark-hover bg-dark-surface' : 'border-gray-700 bg-gray-800/50 opacity-60'}`}>
                    <div className="flex items-start gap-4">
                      <div className="flex-shrink-0">
                        {file.fileType === 'image' ? (
                          <img src={file.fileUrl} alt={file.name} className="w-16 h-16 object-cover rounded-lg" />
                        ) : (
                          <div className="w-16 h-16 bg-dark-hover rounded-lg flex items-center justify-center">
                            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                          </div>
                        )}
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs px-2 py-0.5 bg-neon-blue/20 text-neon-blue rounded">#{idx + 1}</span>
                          <h3 className="font-medium text-white truncate">{file.name}</h3>
                        </div>
                        {file.description && (
                          <p className="text-sm text-gray-400 mt-1 line-clamp-2">{file.description}</p>
                        )}
                        {file.triggerKeywords && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {file.triggerKeywords.split(',').map((kw, i) => (
                              <span key={i} className="text-xs px-2 py-0.5 bg-dark-hover text-gray-300 rounded">{kw.trim()}</span>
                            ))}
                          </div>
                        )}
                        {file.triggerContext && (
                          <p className="text-xs text-gray-500 mt-2 italic">{file.triggerContext}</p>
                        )}
                      </div>
                      
                      <div className="flex flex-col gap-1">
                        <button onClick={() => handleMoveFile(file.id, 'up')} disabled={idx === 0} className="p-1.5 text-gray-400 hover:text-white hover:bg-dark-hover rounded disabled:opacity-30 disabled:cursor-not-allowed">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                        </button>
                        <button onClick={() => handleMoveFile(file.id, 'down')} disabled={idx === agentFiles.length - 1} className="p-1.5 text-gray-400 hover:text-white hover:bg-dark-hover rounded disabled:opacity-30 disabled:cursor-not-allowed">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                        </button>
                      </div>
                      
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleUpdateFile(file.id, { enabled: !file.enabled })}
                          className={`p-2 rounded-lg transition-colors ${file.enabled ? 'text-accent-success hover:bg-accent-success/10' : 'text-gray-500 hover:bg-gray-700'}`}
                          title={file.enabled ? 'Desactivar' : 'Activar'}
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            {file.enabled ? (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            ) : (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                            )}
                          </svg>
                        </button>
                        <a href={file.fileUrl} target="_blank" rel="noopener noreferrer" className="p-2 text-gray-400 hover:text-white hover:bg-dark-hover rounded-lg" title="Ver archivo">
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                        </a>
                        <button onClick={() => handleDeleteFile(file.id)} className="p-2 text-gray-400 hover:text-accent-error hover:bg-accent-error/10 rounded-lg" title="Eliminar">
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card bg-dark-surface/50">
            <h3 className="text-sm font-semibold text-gray-300 mb-2">Como funciona</h3>
            <ul className="text-sm text-gray-400 space-y-2">
              <li className="flex items-start gap-2">
                <span className="text-neon-blue">1.</span>
                <span>Sube archivos como tripticos, catalogos, planos o fotos de productos</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-neon-blue">2.</span>
                <span>Define palabras clave y contexto para que el agente sepa cuando enviarlos</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-neon-blue">3.</span>
                <span>El orden determina la prioridad: archivos arriba tienen precedencia</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-neon-blue">4.</span>
                <span>El agente enviara automaticamente el archivo mas relevante segun la conversacion</span>
              </li>
            </ul>
          </div>
        </div>
      )}

      {agentVersion === 'v2' && activeV2Tab === 'tools' && (
        <div className="space-y-4">
          <div className="card">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Tools Personalizados</h2>
                <p className="text-sm text-gray-400">
                  Agrega endpoints externos que el agente puede usar para obtener informacion.
                </p>
              </div>
              {!showToolForm && (
                <button
                  onClick={() => setShowToolForm(true)}
                  className="btn btn-primary w-full sm:w-auto"
                >
                  + Nuevo Tool
                </button>
              )}
            </div>

            {showToolForm && (
              <div className="border border-dark-hover rounded-lg p-4 mb-4 space-y-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-white">
                    {editingTool ? 'Editar Tool' : 'Nuevo Tool'}
                  </h3>
                  <button
                    onClick={handleCancelToolForm}
                    className="text-sm text-gray-400 hover:text-white"
                  >
                    Cancelar
                  </button>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    Nombre
                  </label>
                  <input
                    type="text"
                    value={newTool.name}
                    onChange={(e) => setNewTool({ ...newTool, name: e.target.value })}
                    className="input"
                    placeholder="buscar_inventario"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    Descripcion
                  </label>
                  <input
                    type="text"
                    value={newTool.description}
                    onChange={(e) => setNewTool({ ...newTool, description: e.target.value })}
                    className="input"
                    placeholder="Busca productos en el inventario externo"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">
                      URL
                    </label>
                    <input
                      type="text"
                      value={newTool.url}
                      onChange={(e) => setNewTool({ ...newTool, url: e.target.value })}
                      className="input"
                      placeholder="https://api.example.com/search"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">
                      Metodo
                    </label>
                    <select
                      value={newTool.method}
                      onChange={(e) => setNewTool({ ...newTool, method: e.target.value })}
                      className="input"
                    >
                      <option value="POST">POST</option>
                      <option value="GET">GET</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    Headers (JSON opcional)
                  </label>
                  <input
                    type="text"
                    value={newTool.headers}
                    onChange={(e) => setNewTool({ ...newTool, headers: e.target.value })}
                    className="input font-mono text-sm"
                    placeholder='{"Authorization": "Bearer xxx"}'
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    Body Template (JSON opcional)
                  </label>
                  <textarea
                    value={newTool.bodyTemplate}
                    onChange={(e) => setNewTool({ ...newTool, bodyTemplate: e.target.value })}
                    className="input font-mono text-sm resize-none"
                    rows={3}
                    placeholder='{"orderId": "{{orderId}}", "email": "{{email}}"}'
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Usa {"{{paramName}}"} para insertar parametros dinamicos
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-gray-300">
                      Parametros
                    </label>
                    <button
                      type="button"
                      onClick={() => setNewTool({
                        ...newTool,
                        parameters: [...newTool.parameters, { name: '', type: 'string', description: '', required: true }]
                      })}
                      className="text-sm text-neon-blue hover:text-cyan-400"
                    >
                      + Agregar Parametro
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 mb-2">
                    Define los campos que el agente debe extraer para llamar este endpoint.
                  </p>
                  
                  {newTool.parameters.length === 0 ? (
                    <p className="text-sm text-gray-500 text-center py-2">Sin parametros definidos</p>
                  ) : (
                    <div className="space-y-2">
                      {newTool.parameters.map((param, index) => (
                        <div key={index} className="flex flex-wrap gap-2 items-center bg-dark-hover p-2 rounded">
                          <input
                            type="text"
                            value={param.name}
                            onChange={(e) => {
                              const params = [...newTool.parameters];
                              params[index].name = e.target.value;
                              setNewTool({ ...newTool, parameters: params });
                            }}
                            className="input flex-1 min-w-[100px]"
                            placeholder="nombre"
                          />
                          <select
                            value={param.type}
                            onChange={(e) => {
                              const params = [...newTool.parameters];
                              params[index].type = e.target.value;
                              setNewTool({ ...newTool, parameters: params });
                            }}
                            className="input w-24"
                          >
                            <option value="string">string</option>
                            <option value="number">number</option>
                            <option value="boolean">boolean</option>
                          </select>
                          <input
                            type="text"
                            value={param.description}
                            onChange={(e) => {
                              const params = [...newTool.parameters];
                              params[index].description = e.target.value;
                              setNewTool({ ...newTool, parameters: params });
                            }}
                            className="input flex-1 min-w-[150px]"
                            placeholder="Descripcion"
                          />
                          <label className="flex items-center gap-1 text-xs text-gray-400">
                            <input
                              type="checkbox"
                              checked={param.required}
                              onChange={(e) => {
                                const params = [...newTool.parameters];
                                params[index].required = e.target.checked;
                                setNewTool({ ...newTool, parameters: params });
                              }}
                              className="w-4 h-4 rounded border-gray-600 bg-dark-surface text-neon-blue"
                            />
                            Req
                          </label>
                          <button
                            type="button"
                            onClick={() => {
                              const params = newTool.parameters.filter((_, i) => i !== index);
                              setNewTool({ ...newTool, parameters: params });
                            }}
                            className="text-accent-error hover:text-red-400"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-gray-300">
                      Variables Dinamicas (AI)
                    </label>
                    <button
                      type="button"
                      onClick={() => setNewTool({
                        ...newTool,
                        dynamicVariables: [...newTool.dynamicVariables, { name: '', description: '', formatExample: '' }]
                      })}
                      className="text-sm text-purple-400 hover:text-purple-300"
                    >
                      + Agregar Variable
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 mb-2">
                    Define variables que el AI extraera de la conversacion. Usa {"{{nombre}}"} en la URL o Body.
                  </p>
                  
                  {newTool.dynamicVariables.length === 0 ? (
                    <p className="text-sm text-gray-500 text-center py-2">Sin variables dinamicas</p>
                  ) : (
                    <div className="space-y-2">
                      {newTool.dynamicVariables.map((v, index) => (
                        <div key={index} className="bg-dark-hover p-3 rounded space-y-2">
                          <div className="flex gap-2 items-center">
                            <input
                              type="text"
                              value={v.name}
                              onChange={(e) => {
                                const vars = [...newTool.dynamicVariables];
                                vars[index].name = e.target.value.replace(/[^a-zA-Z0-9_]/g, '');
                                setNewTool({ ...newTool, dynamicVariables: vars });
                              }}
                              className="input flex-1"
                              placeholder="nombre_variable"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const vars = newTool.dynamicVariables.filter((_, i) => i !== index);
                                setNewTool({ ...newTool, dynamicVariables: vars });
                              }}
                              className="text-accent-error hover:text-red-400"
                            >
                              ✕
                            </button>
                          </div>
                          <input
                            type="text"
                            value={v.description}
                            onChange={(e) => {
                              const vars = [...newTool.dynamicVariables];
                              vars[index].description = e.target.value;
                              setNewTool({ ...newTool, dynamicVariables: vars });
                            }}
                            className="input w-full"
                            placeholder="Descripcion para que el AI sepa que extraer"
                          />
                          <input
                            type="text"
                            value={v.formatExample}
                            onChange={(e) => {
                              const vars = [...newTool.dynamicVariables];
                              vars[index].formatExample = e.target.value;
                              setNewTool({ ...newTool, dynamicVariables: vars });
                            }}
                            className="input w-full font-mono text-sm"
                            placeholder="Formato ejemplo: 2025-01-15 o 2025-01-15T10:30:00Z"
                          />
                          <p className="text-xs text-purple-400">
                            Usa: {"{{" + (v.name || 'variable') + "}}"}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex gap-2 mt-4">
                  <button
                    onClick={handleCancelToolForm}
                    className="btn btn-secondary flex-1"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={editingTool ? handleUpdateTool : handleCreateTool}
                    disabled={loading || !newTool.name || !newTool.url}
                    className="btn btn-primary flex-1"
                  >
                    {loading ? 'Guardando...' : editingTool ? 'Actualizar' : 'Crear'}
                  </button>
                </div>
              </div>
            )}

            {tools.length === 0 && !showToolForm ? (
              <div className="text-center py-8">
                <div className="text-4xl mb-2">🔧</div>
                <p className="text-gray-400">No tienes tools configurados.</p>
                <p className="text-sm text-gray-500">Agrega endpoints externos para que el agente pueda consultar informacion.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {tools.map(tool => (
                  <div key={tool.id} className="border border-dark-hover rounded-lg p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-white">{tool.name}</h3>
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            tool.enabled ? 'bg-accent-success/20 text-accent-success' : 'bg-gray-700 text-gray-400'
                          }`}>
                            {tool.enabled ? 'Activo' : 'Inactivo'}
                          </span>
                          <span className="px-2 py-0.5 bg-dark-hover text-gray-400 rounded text-xs">
                            {tool.method}
                          </span>
                        </div>
                        <p className="text-sm text-gray-400">{tool.description}</p>
                        <p className="text-xs text-gray-500 mt-1 truncate">{tool.url}</p>
                        {tool.parameters && tool.parameters.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {tool.parameters.map((p, i) => (
                              <span key={i} className="text-xs bg-neon-blue/20 text-neon-blue px-2 py-0.5 rounded">
                                {p.name}{p.required ? '*' : ''}
                              </span>
                            ))}
                          </div>
                        )}
                        {tool.dynamicVariables && tool.dynamicVariables.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {tool.dynamicVariables.map((v, i) => (
                              <span key={i} className="text-xs bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded" title={v.description + (v.formatExample ? ` (ej: ${v.formatExample})` : '')}>
                                {"{{" + v.name + "}}"}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col sm:flex-row gap-1">
                        <button
                          onClick={() => handleToggleTool(tool)}
                          className="btn btn-secondary btn-sm"
                          title={tool.enabled ? 'Desactivar' : 'Activar'}
                        >
                          {tool.enabled ? '⏸' : '▶'}
                        </button>
                        <button
                          onClick={() => handleViewLogs(tool)}
                          className="btn btn-secondary btn-sm"
                          title="Ver logs"
                        >
                          📋
                        </button>
                        <button
                          onClick={() => handleOpenTestModal(tool)}
                          className="btn btn-secondary btn-sm"
                          title="Probar Tool"
                        >
                          🧪
                        </button>
                        <button
                          onClick={() => handleEditTool(tool)}
                          className="btn btn-secondary btn-sm"
                          title="Editar"
                        >
                          ✏️
                        </button>
                        <button
                          onClick={() => handleDeleteTool(tool.id)}
                          className="btn btn-danger btn-sm"
                          title="Eliminar"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                    {testResult && testResult.toolId === tool.id && (
                      <div className={`mt-3 p-2 rounded text-sm ${
                        testResult.error ? 'bg-accent-error/10 text-accent-error' : 'bg-accent-success/10 text-accent-success'
                      }`}>
                        <pre className="whitespace-pre-wrap text-xs">
                          {JSON.stringify(testResult, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {agentVersion === 'v2' && activeV2Tab === 'api' && (
        <div className="space-y-6">
          <div className="card">
            <h2 className="text-lg font-semibold text-white mb-2">API Key</h2>
            <p className="text-sm text-gray-400 mb-4">
              Genera una API key para acceder a los endpoints de tu negocio desde aplicaciones externas.
            </p>

            {newApiKey && (
              <div className="bg-accent-success/10 border border-accent-success/30 rounded-lg p-4 mb-4">
                <p className="text-sm text-accent-success font-medium mb-2">Tu nueva API key (guardala ahora):</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-dark-surface p-2 rounded text-xs text-white font-mono break-all">
                    {newApiKey}
                  </code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(newApiKey);
                      setSuccess('API key copiada');
                    }}
                    className="btn btn-secondary btn-sm"
                  >
                    Copiar
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  Esta es la unica vez que veras esta key. Guardala en un lugar seguro.
                </p>
              </div>
            )}

            {apiKeyInfo?.hasApiKey && !newApiKey && (
              <div className="bg-dark-surface rounded-lg p-4 mb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-300">API Key activa</p>
                    <p className="text-xs text-gray-500 font-mono mt-1">{apiKeyInfo.prefix}...</p>
                  </div>
                  <p className="text-xs text-gray-500">
                    Creada: {apiKeyInfo.createdAt ? new Date(apiKeyInfo.createdAt).toLocaleDateString() : '-'}
                  </p>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleGenerateApiKey}
                disabled={loadingApiKey}
                className="btn btn-primary"
              >
                {loadingApiKey ? 'Generando...' : apiKeyInfo?.hasApiKey ? 'Regenerar API Key' : 'Generar API Key'}
              </button>
              {apiKeyInfo?.hasApiKey && (
                <button
                  onClick={handleRevokeApiKey}
                  disabled={loadingApiKey}
                  className="btn btn-danger"
                >
                  Revocar
                </button>
              )}
            </div>

            <div className="mt-4 p-3 bg-dark-surface rounded-lg">
              <p className="text-xs text-gray-400 mb-2">Uso:</p>
              <code className="text-xs text-gray-300 font-mono">
                Authorization: Bearer efk_...
              </code>
            </div>
          </div>

          <div className="card">
            <h2 className="text-lg font-semibold text-white mb-2">Webhook</h2>
            <p className="text-sm text-gray-400 mb-4">
              Configura un webhook para recibir notificaciones de eventos en tiempo real.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">URL del Webhook</label>
                <input
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://tu-servidor.com/webhook"
                  className="input"
                />
                <p className="text-xs text-gray-500 mt-1">Debe ser HTTPS</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Eventos</label>
                <div className="grid grid-cols-2 gap-2">
                  {(webhookConfig?.availableEvents || ['user_message', 'agent_message', 'state_change', 'tool_call', 'stage_change']).map(event => (
                    <label key={event} className="flex items-center gap-2 p-2 bg-dark-surface rounded-lg cursor-pointer hover:bg-dark-hover">
                      <input
                        type="checkbox"
                        checked={selectedEvents.includes(event)}
                        onChange={() => handleToggleEvent(event)}
                        className="w-4 h-4 rounded border-gray-600 bg-dark-hover text-neon-blue focus:ring-neon-blue"
                      />
                      <span className="text-sm text-gray-300">{event.replace(/_/g, ' ')}</span>
                    </label>
                  ))}
                </div>
              </div>

              {webhookConfig?.webhookSecret && (
                <div className="p-3 bg-dark-surface rounded-lg">
                  <p className="text-xs text-gray-400 mb-1">Webhook Secret (para verificar firmas):</p>
                  <code className="text-xs text-gray-300 font-mono break-all">{webhookConfig.webhookSecret}</code>
                </div>
              )}

              <button
                onClick={handleSaveWebhook}
                disabled={loadingWebhook}
                className="btn btn-primary"
              >
                {loadingWebhook ? 'Guardando...' : 'Guardar Webhook'}
              </button>
            </div>
          </div>

          <div className="card bg-dark-surface/50">
            <h3 className="text-sm font-semibold text-gray-300 mb-2">Formato de Eventos</h3>
            <div className="text-xs text-gray-400 space-y-2">
              <p><strong>user_message:</strong> Cuando un usuario envia un mensaje (incluye texto, imagenes, audio, video)</p>
              <p><strong>agent_message:</strong> Cuando el agente responde (incluye respuesta y media enviada)</p>
              <p><strong>state_change:</strong> Cuando cambia el estado del cliente (etapa, tags)</p>
              <p><strong>tool_call:</strong> Cuando el agente ejecuta una herramienta</p>
              <p><strong>stage_change:</strong> Cuando el cliente avanza de etapa</p>
            </div>
          </div>
        </div>
      )}

      {showLogsModal && selectedToolForLogs && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-3xl w-full max-h-[80vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">
                Logs: {selectedToolForLogs.name}
              </h2>
              <button onClick={handleCloseLogsModal} className="text-gray-400 hover:text-white">
                ✕
              </button>
            </div>

            {toolStats && (
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="bg-dark-hover rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-white">{toolStats.totalCalls}</p>
                  <p className="text-xs text-gray-400">Llamadas totales</p>
                </div>
                <div className="bg-dark-hover rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-white">{toolStats.avgDuration?.toFixed(0) || 0}ms</p>
                  <p className="text-xs text-gray-400">Tiempo promedio</p>
                </div>
                <div className="bg-dark-hover rounded-lg p-3 text-center">
                  <p className="text-sm font-medium text-white">
                    {toolStats.lastCall ? new Date(toolStats.lastCall).toLocaleDateString() : '-'}
                  </p>
                  <p className="text-xs text-gray-400">Ultima llamada</p>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {loadingLogs ? (
                <div className="text-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-neon-blue mx-auto"></div>
                </div>
              ) : toolLogs.length === 0 ? (
                <div className="text-center py-8 text-gray-400">
                  No hay logs disponibles
                </div>
              ) : (
                <div className="space-y-2">
                  {toolLogs.map(log => (
                    <div key={log.id} className="bg-dark-hover rounded-lg p-3 text-sm">
                      <div className="flex items-center justify-between mb-2">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          log.status === 'success' ? 'bg-accent-success/20 text-accent-success' : 'bg-accent-error/20 text-accent-error'
                        }`}>
                          {log.status}
                        </span>
                        <span className="text-xs text-gray-500">
                          {new Date(log.createdAt).toLocaleString()}
                          {log.duration && ` - ${log.duration}ms`}
                        </span>
                      </div>
                      {log.contactPhone && (
                        <p className="text-xs text-gray-400 mb-1">Tel: {log.contactPhone}</p>
                      )}
                      <details className="text-xs">
                        <summary className="cursor-pointer text-gray-400 hover:text-white">Ver detalles</summary>
                        <pre className="mt-2 p-2 bg-dark-surface rounded overflow-x-auto text-gray-300">
                          {JSON.stringify({ request: log.request, response: log.response }, null, 2)}
                        </pre>
                      </details>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button onClick={handleCloseLogsModal} className="btn btn-secondary mt-4">
              Cerrar
            </button>
          </div>
        </div>
      )}

      {showTestModal && testingTool && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-lg w-full max-h-[80vh] overflow-auto">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  Test: {testingTool.name}
                </h2>
                <p className="text-xs text-gray-400 mt-1">
                  <span className="px-2 py-0.5 bg-dark-hover rounded mr-2">{testingTool.method}</span>
                  {testingTool.url.length > 50 ? testingTool.url.substring(0, 50) + '...' : testingTool.url}
                </p>
              </div>
              <button onClick={handleCloseTestModal} className="text-gray-400 hover:text-white text-xl">
                ✕
              </button>
            </div>

            {Object.keys(testVariables).length > 0 ? (
              <div className="space-y-3 mb-4">
                <p className="text-sm text-gray-300 font-medium">Variables detectadas:</p>
                {Object.keys(testVariables).map(varName => {
                  const dynVar = testingTool.dynamicVariables?.find(v => v.name === varName);
                  return (
                    <div key={varName} className="space-y-1">
                      <label className="block text-sm text-gray-400">
                        <span className="font-mono text-purple-400">{`{{${varName}}}`}</span>
                        {dynVar?.description && (
                          <span className="text-xs text-gray-500 ml-2">- {dynVar.description}</span>
                        )}
                      </label>
                      <input
                        type="text"
                        value={testVariables[varName]}
                        onChange={(e) => setTestVariables({ ...testVariables, [varName]: e.target.value })}
                        placeholder={dynVar?.formatExample || `Valor para ${varName}`}
                        className="input font-mono text-sm"
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="bg-dark-hover rounded-lg p-3 mb-4">
                <p className="text-sm text-gray-400">No hay variables dinamicas en esta tool.</p>
              </div>
            )}

            <button
              onClick={handleExecuteTest}
              disabled={testLoading}
              className="btn btn-primary w-full mb-4"
            >
              {testLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Ejecutando...
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  ▶ Ejecutar Test
                </span>
              )}
            </button>

            {testResponse && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-300">Resultado:</span>
                  {testResponse.duration && (
                    <span className="text-xs text-gray-500">{testResponse.duration}ms</span>
                  )}
                </div>
                
                {testResponse.error ? (
                  <div className="bg-accent-error/10 border border-accent-error/30 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-accent-error font-medium">Error</span>
                    </div>
                    <p className="text-sm text-accent-error">{testResponse.error}</p>
                  </div>
                ) : (
                  <div className={`rounded-lg p-3 ${
                    testResponse.status && testResponse.status >= 200 && testResponse.status < 300
                      ? 'bg-accent-success/10 border border-accent-success/30'
                      : 'bg-yellow-500/10 border border-yellow-500/30'
                  }`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                        testResponse.status && testResponse.status >= 200 && testResponse.status < 300
                          ? 'bg-accent-success text-white'
                          : 'bg-yellow-500 text-black'
                      }`}>
                        {testResponse.status}
                      </span>
                      <span className={`text-sm ${
                        testResponse.status && testResponse.status >= 200 && testResponse.status < 300
                          ? 'text-accent-success'
                          : 'text-yellow-500'
                      }`}>
                        {testResponse.status && testResponse.status >= 200 && testResponse.status < 300 ? 'OK' : 'Warning'}
                      </span>
                    </div>
                    <pre className="text-xs text-gray-300 bg-dark-surface rounded p-2 overflow-x-auto max-h-48 overflow-y-auto">
                      {typeof testResponse.data === 'string' 
                        ? testResponse.data 
                        : JSON.stringify(testResponse.data, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}

            <button onClick={handleCloseTestModal} className="btn btn-secondary w-full mt-4">
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

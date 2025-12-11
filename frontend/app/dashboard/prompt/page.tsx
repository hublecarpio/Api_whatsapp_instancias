'use client';

import { useState, useEffect } from 'react';
import { useBusinessStore } from '@/store/business';
import { useAuthStore } from '@/store/auth';
import { promptApi, toolsApi, businessApi, agentV2Api } from '@/lib/api';
import { SkillsV2Panel, PromptsV2Panel, LeadMemoryPanel, RulesLearnedPanel, KnowledgePanel } from '@/components/AgentV2';

interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
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
    parameters: [] as ToolParameter[]
  });
  const [testResult, setTestResult] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'prompt' | 'config' | 'tools'>('prompt');
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
  const [activeV2Tab, setActiveV2Tab] = useState<'skills' | 'prompts' | 'memory' | 'rules' | 'knowledge' | 'config'>('skills');

  useEffect(() => {
    if (currentBusiness) {
      setBotEnabled(currentBusiness.botEnabled);
      const version = (currentBusiness as any).agentVersion || 'v1';
      setAgentVersion(version);
      loadData();
      if (version === 'v2') {
        loadV2Data();
      }
    }
  }, [currentBusiness]);

  useEffect(() => {
    if (currentBusiness && agentVersion === 'v2') {
      loadV2Data();
    }
  }, [agentVersion]);

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
        parameters: newTool.parameters.length > 0 ? newTool.parameters : undefined
      });
      
      setShowToolForm(false);
      setNewTool({ name: '', description: '', url: '', method: 'POST', headers: '', bodyTemplate: '', parameters: [] });
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
      parameters: tool.parameters || []
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
        parameters: newTool.parameters.length > 0 ? newTool.parameters : null
      });
      
      setShowToolForm(false);
      setEditingTool(null);
      setNewTool({ name: '', description: '', url: '', method: 'POST', headers: '', bodyTemplate: '', parameters: [] });
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
    setNewTool({ name: '', description: '', url: '', method: 'POST', headers: '', bodyTemplate: '', parameters: [] });
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
            onClick={() => setActiveTab('tools')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'tools' ? 'bg-neon-blue text-dark-bg' : 'bg-dark-card text-gray-400 hover:text-white'
            }`}
          >
            Tools ({tools.length})
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 mb-6">
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

      {agentVersion === 'v1' && activeTab === 'tools' && (
        <div className="space-y-4">
          <div className="card">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Tools Externos</h2>
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
                          onClick={() => handleTestTool(tool)}
                          className="btn btn-secondary btn-sm"
                          title="Probar"
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
    </div>
  );
}

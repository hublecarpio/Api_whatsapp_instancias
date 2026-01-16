'use client';

import { useState, useEffect } from 'react';
import { agentHealthApi, businessApi } from '@/lib/api';

const AVAILABLE_MODELS = [
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', provider: 'OpenAI' },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', provider: 'OpenAI' },
  { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'OpenAI' },
  { id: 'google/gemini-2.5-flash-preview', name: 'Gemini 2.5 Flash', provider: 'Google' },
  { id: 'google/gemini-2.5-pro-preview', name: 'Gemini 2.5 Pro', provider: 'Google' },
  { id: 'google/gemini-3-flash-preview', name: 'Gemini 3 Flash', provider: 'Google' },
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'Anthropic' }
];

interface ToolInfo {
  name: string;
  type: 'builtin' | 'custom';
  description: string;
  endpoint?: string;
  reason?: string;
  method?: string;
}

interface ContextItem {
  name: string;
  description: string;
  count?: number;
  files?: string[];
}

interface ContextNetwork {
  prompt: {
    masterPrompt: { enabled: boolean; length: number; preview: string } | null;
    bufferSeconds: number;
    historyLimit: number;
    splitMessages: boolean;
  };
  policy: {
    enabled: boolean;
    sections: {
      shippingPolicy: boolean;
      refundPolicy: boolean;
      brandVoice: boolean;
      allowedHours: boolean;
    };
  } | null;
  catalog: {
    mode: 'search_tool' | 'in_prompt' | 'empty';
    count: number;
    products: Array<{ id: string; title: string; price: number; stock: number; hasImage: boolean }>;
    hasMore: boolean;
  };
  leadStages: {
    enabled: boolean;
    count: number;
    stages: Array<{ name: string; color: string; description: string | null }>;
  };
  dataExtraction: {
    enabled: boolean;
    count: number;
    fields: Array<{ key: string; label: string; type: string; description: string | null }>;
  };
  reminders: {
    pendingCount: number;
    nextReminders: Array<{ phone: string; scheduledAt: string }>;
  };
  availability: {
    enabled: boolean;
    days: Array<{ day: number; start: string; end: string }>;
  } | null;
  files: {
    enabled: boolean;
    count: number;
    files: Array<{ name: string; url: string }>;
  } | null;
  instance: {
    connected: boolean;
    provider: string;
    phoneNumber: string | null;
    status: string;
  } | null;
  subscription: {
    tier: string;
    status: string;
    paymentLinkEnabled: boolean;
  };
  sections: {
    core: Array<{ title: string; type: string; contentPreview: string }>;
    rag: Array<{ title: string; type: string; hasEmbedding: boolean; contentPreview: string }>;
  };
  customTools: Array<{ name: string; description: string; endpoint: string; method: string }>;
}

interface AgentHealth {
  objective: string;
  objectiveLabel: string;
  model: string;
  botEnabled: boolean;
  timezone: string;
  currencyCode: string;
  currencySymbol: string;
  instanceConnected: boolean;
  paymentLinkEnabled: boolean;
  paymentMode: string;
  activeTools: ToolInfo[];
  inactiveTools: ToolInfo[];
  contextItems: ContextItem[];
  warnings: string[];
  stats: {
    productCount: number;
    customToolCount: number;
    fileCount: number;
    ragSectionCount: number;
    coreSectionCount: number;
    leadStageCount: number;
    extractionFieldCount: number;
    pendingReminderCount: number;
  };
  contextNetwork: ContextNetwork;
}

const DAYS = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];

interface Props {
  businessId: string;
  instanceId?: string | null;
}

export default function AgentHealthDashboard({ businessId, instanceId }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [showNetwork, setShowNetwork] = useState(false);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [savingModel, setSavingModel] = useState(false);

  const handleModelChange = async (modelId: string) => {
    if (!businessId) return;
    setSavingModel(true);
    try {
      await businessApi.updateModel(businessId, modelId);
      if (health) {
        setHealth({ ...health, model: modelId });
      }
      setShowModelSelector(false);
    } catch (error) {
      console.error('Failed to update model:', error);
    } finally {
      setSavingModel(false);
    }
  };

  const fetchHealth = async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      const response = await agentHealthApi.get(businessId, instanceId || undefined);
      setHealth(response.data);
    } catch (error) {
      console.error('Failed to fetch agent health:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchHealth();
    }
  }, [isOpen, businessId, instanceId]);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 bg-dark-card border border-dark-border rounded-lg text-sm text-gray-400 hover:text-white hover:border-neon-blue transition-colors"
        title="Ver estado del agente"
      >
        <span className="text-lg">🔍</span>
        <span className="hidden sm:inline">Estado IA</span>
      </button>
    );
  }

  const cn = health?.contextNetwork;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-surface border border-dark-border rounded-xl w-full max-w-4xl max-h-[90vh] overflow-auto">
        <div className="sticky top-0 bg-dark-surface border-b border-dark-border p-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🧠</span>
            <div>
              <h2 className="text-lg font-semibold text-white">Estado del Agente IA</h2>
              <p className="text-xs text-gray-400">Red completa de contexto y herramientas</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowNetwork(!showNetwork)}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                showNetwork ? 'bg-neon-purple/20 text-neon-purple' : 'bg-dark-card text-gray-400 hover:text-white'
              }`}
            >
              {showNetwork ? '📊 Resumen' : '🔗 Red Completa'}
            </button>
            <button
              onClick={() => setIsOpen(false)}
              className="text-gray-400 hover:text-white text-xl px-2"
            >
              ✕
            </button>
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-gray-400">Cargando...</div>
        ) : health ? (
          <div className="p-4 space-y-6">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="bg-dark-card rounded-lg p-3 text-center border border-dark-border">
                <div className={`text-2xl mb-1 ${health.botEnabled ? '' : 'opacity-30'}`}>
                  {health.botEnabled ? '🟢' : '🔴'}
                </div>
                <div className="text-xs text-gray-400">Bot</div>
                <div className="text-sm text-white">{health.botEnabled ? 'Activo' : 'Pausado'}</div>
              </div>
              <div className="bg-dark-card rounded-lg p-3 text-center border border-dark-border">
                <div className={`text-2xl mb-1 ${health.instanceConnected ? '' : 'opacity-30'}`}>
                  {health.instanceConnected ? '📱' : '📵'}
                </div>
                <div className="text-xs text-gray-400">WhatsApp</div>
                <div className="text-sm text-white">{health.instanceConnected ? 'Conectado' : 'Desconectado'}</div>
              </div>
              <div className="bg-dark-card rounded-lg p-3 text-center border border-dark-border">
                <div className="text-2xl mb-1">{health.objective === 'APPOINTMENTS' ? '📅' : '🛒'}</div>
                <div className="text-xs text-gray-400">Modo</div>
                <div className="text-sm text-white">{health.objectiveLabel}</div>
              </div>
              <div 
                className="bg-dark-card rounded-lg p-3 text-center border border-dark-border cursor-pointer hover:border-neon-blue transition-colors relative"
                onClick={() => setShowModelSelector(!showModelSelector)}
              >
                <div className="text-2xl mb-1">🤖</div>
                <div className="text-xs text-gray-400">Modelo</div>
                <div className="text-sm text-neon-blue truncate flex items-center justify-center gap-1" title={health.model}>
                  {AVAILABLE_MODELS.find(m => m.id === health.model)?.name || health.model}
                  <span className="text-xs">▼</span>
                </div>
                {showModelSelector && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-dark-surface/95 backdrop-blur-md border border-dark-border rounded-lg shadow-xl z-20 max-h-60 overflow-auto">
                    {AVAILABLE_MODELS.map(model => (
                      <button
                        key={model.id}
                        onClick={(e) => { e.stopPropagation(); handleModelChange(model.id); }}
                        disabled={savingModel}
                        className={`w-full px-3 py-2 text-left text-sm hover:bg-dark-card transition-colors ${
                          health.model === model.id ? 'text-neon-blue bg-neon-blue/10' : 'text-white'
                        }`}
                      >
                        <div className="font-medium">{model.name}</div>
                        <div className="text-xs text-gray-500">{model.provider}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="bg-dark-card rounded-lg p-3 text-center border border-dark-border">
                <div className="text-2xl mb-1">🌍</div>
                <div className="text-xs text-gray-400">Zona</div>
                <div className="text-sm text-white truncate" title={health.timezone}>{health.timezone.split('/')[1] || health.timezone}</div>
              </div>
            </div>

            {health.warnings.length > 0 && (
              <div className="bg-accent-warning/10 border border-accent-warning/30 rounded-lg p-3">
                <div className="flex items-center gap-2 text-accent-warning text-sm font-medium mb-2">
                  <span>⚠️</span> Advertencias
                </div>
                <ul className="space-y-1">
                  {health.warnings.map((warning, i) => (
                    <li key={i} className="text-sm text-gray-300 flex items-start gap-2">
                      <span className="text-accent-warning">•</span>
                      {warning}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!showNetwork ? (
              <>
                {health.objective === 'SALES' && (
                  <div className={`rounded-lg p-3 border ${health.paymentLinkEnabled ? 'bg-accent-success/10 border-accent-success/30' : 'bg-dark-card border-dark-border'}`}>
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{health.paymentLinkEnabled ? '💳' : '🧾'}</span>
                      <div>
                        <div className="text-sm font-medium text-white">Modo de Pago: {health.paymentMode}</div>
                        <div className="text-xs text-gray-400">
                          {health.paymentLinkEnabled 
                            ? 'Links de pago con Stripe activado por Super Admin' 
                            : 'Pedidos con voucher/comprobante (por defecto)'}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div>
                  <h3 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                    <span className="text-accent-success">⚡</span> Herramientas Activas ({health.activeTools.length})
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {health.activeTools.map((tool, i) => (
                      <div key={i} className="bg-dark-card rounded-lg p-3 border border-accent-success/30">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-accent-success text-xs">●</span>
                          <span className="text-white text-sm font-medium">{tool.name}</span>
                          {tool.type === 'custom' && (
                            <span className="text-xs px-1.5 py-0.5 bg-accent-purple/20 text-accent-purple rounded">custom</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400">{tool.description}</p>
                        {tool.endpoint && (
                          <p className="text-xs text-gray-500 truncate mt-1" title={tool.endpoint}>→ {tool.endpoint}</p>
                        )}
                      </div>
                    ))}
                    {health.activeTools.length === 0 && (
                      <p className="text-sm text-gray-500 col-span-2">Sin herramientas activas</p>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                    <span className="text-gray-500">○</span> Herramientas Inactivas ({health.inactiveTools.length})
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {health.inactiveTools.map((tool, i) => (
                      <div key={i} className="bg-dark-card/50 rounded-lg p-3 border border-dark-border opacity-60">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-gray-500 text-xs">○</span>
                          <span className="text-gray-400 text-sm">{tool.name}</span>
                        </div>
                        <p className="text-xs text-gray-500">{tool.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {health.contextItems.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                      <span className="text-neon-blue">📋</span> Contexto en Prompt
                    </h3>
                    <div className="space-y-2">
                      {health.contextItems.map((item, i) => (
                        <div key={i} className="bg-dark-card rounded-lg p-3 border border-neon-blue/20">
                          <div className="flex items-center justify-between">
                            <span className="text-white text-sm">{item.name}</span>
                            {item.count !== undefined && (
                              <span className="text-xs px-2 py-0.5 bg-neon-blue/20 text-neon-blue rounded">{item.count}</span>
                            )}
                          </div>
                          <p className="text-xs text-gray-400 mt-1">{item.description}</p>
                          {item.files && item.files.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {item.files.slice(0, 3).map((file, j) => (
                                <span key={j} className="text-xs px-2 py-0.5 bg-dark-hover rounded text-gray-300">{file}</span>
                              ))}
                              {item.files.length > 3 && (
                                <span className="text-xs px-2 py-0.5 bg-dark-hover rounded text-gray-400">+{item.files.length - 3} mas</span>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
                  <h3 className="text-sm font-medium text-white mb-3">📊 Estadisticas Rapidas</h3>
                  <div className="grid grid-cols-4 gap-3 text-center">
                    <div>
                      <div className="text-xl font-bold text-neon-blue">{health.stats.productCount}</div>
                      <div className="text-xs text-gray-400">Productos</div>
                    </div>
                    <div>
                      <div className="text-xl font-bold text-neon-purple">{health.stats.leadStageCount}</div>
                      <div className="text-xs text-gray-400">Etapas</div>
                    </div>
                    <div>
                      <div className="text-xl font-bold text-accent-success">{health.stats.extractionFieldCount}</div>
                      <div className="text-xs text-gray-400">Campos Auto</div>
                    </div>
                    <div>
                      <div className="text-xl font-bold text-accent-warning">{health.stats.pendingReminderCount}</div>
                      <div className="text-xs text-gray-400">Recordatorios</div>
                    </div>
                  </div>
                </div>
              </>
            ) : cn && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                  🔗 Red Completa de Contexto
                </h3>
                <p className="text-sm text-gray-400">Todo lo que influye en el comportamiento del agente IA</p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
                    <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                      <span className="text-neon-blue">📝</span> Prompt Master
                    </h4>
                    {cn.prompt.masterPrompt ? (
                      <div className="space-y-2">
                        <div className="text-xs text-gray-400">
                          Longitud: <span className="text-white">{cn.prompt.masterPrompt.length} caracteres</span>
                        </div>
                        <div className="text-xs text-gray-500 bg-dark-hover p-2 rounded italic">
                          "{cn.prompt.masterPrompt.preview}"
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500">No configurado</p>
                    )}
                    <div className="flex gap-4 mt-3 text-xs text-gray-400">
                      <span>Buffer: {cn.prompt.bufferSeconds}s</span>
                      <span>Historial: {cn.prompt.historyLimit} msgs</span>
                      <span>Split: {cn.prompt.splitMessages ? 'Si' : 'No'}</span>
                    </div>
                  </div>

                  <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
                    <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                      <span className="text-accent-success">📜</span> Politicas
                    </h4>
                    {cn.policy ? (
                      <div className="flex flex-wrap gap-2">
                        {cn.policy.sections.shippingPolicy && <span className="text-xs px-2 py-1 bg-accent-success/20 text-accent-success rounded">Envios</span>}
                        {cn.policy.sections.refundPolicy && <span className="text-xs px-2 py-1 bg-accent-success/20 text-accent-success rounded">Devoluciones</span>}
                        {cn.policy.sections.brandVoice && <span className="text-xs px-2 py-1 bg-accent-success/20 text-accent-success rounded">Tono Marca</span>}
                        {cn.policy.sections.allowedHours && <span className="text-xs px-2 py-1 bg-accent-success/20 text-accent-success rounded">Horarios</span>}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500">No configuradas</p>
                    )}
                  </div>

                  <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
                    <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                      <span className="text-neon-purple">🛒</span> Catalogo ({cn.catalog.count} productos)
                    </h4>
                    <div className="text-xs text-gray-400 mb-2">
                      Modo: <span className="text-white">{cn.catalog.mode === 'search_tool' ? 'Busqueda con IA' : cn.catalog.mode === 'in_prompt' ? 'Incluido en prompt' : 'Vacio'}</span>
                    </div>
                    {cn.catalog.products.length > 0 && (
                      <div className="space-y-1">
                        {cn.catalog.products.slice(0, 3).map((p, i) => (
                          <div key={i} className="flex justify-between text-xs">
                            <span className="text-gray-300 truncate">{p.title}</span>
                            <span className="text-neon-blue">{health.currencySymbol}{p.price}</span>
                          </div>
                        ))}
                        {cn.catalog.hasMore && <p className="text-xs text-gray-500">+ mas productos...</p>}
                      </div>
                    )}
                  </div>

                  <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
                    <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                      <span className="text-accent-warning">🏷️</span> Etapas del Lead ({cn.leadStages.count})
                    </h4>
                    {cn.leadStages.enabled ? (
                      <div className="flex flex-wrap gap-2">
                        {cn.leadStages.stages.map((s, i) => (
                          <span key={i} className="text-xs px-2 py-1 rounded" style={{ backgroundColor: `${s.color}20`, color: s.color }}>
                            {s.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500">Sin etapas configuradas</p>
                    )}
                  </div>

                  <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
                    <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                      <span className="text-neon-blue">📋</span> Extraccion de Datos ({cn.dataExtraction.count})
                    </h4>
                    {cn.dataExtraction.enabled ? (
                      <div className="space-y-1">
                        {cn.dataExtraction.fields.map((f, i) => (
                          <div key={i} className="flex justify-between text-xs">
                            <span className="text-gray-300">{f.label}</span>
                            <span className="text-gray-500">{f.type}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500">Sin campos configurados</p>
                    )}
                  </div>

                  <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
                    <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                      <span className="text-accent-success">🔔</span> Recordatorios ({cn.reminders.pendingCount} pendientes)
                    </h4>
                    {cn.reminders.nextReminders.length > 0 ? (
                      <div className="space-y-1">
                        {cn.reminders.nextReminders.map((r, i) => (
                          <div key={i} className="flex justify-between text-xs">
                            <span className="text-gray-300">+{r.phone.slice(-4)}</span>
                            <span className="text-gray-500">{new Date(r.scheduledAt).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500">Sin recordatorios pendientes</p>
                    )}
                  </div>

                  {cn.availability && (
                    <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
                      <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                        <span className="text-neon-purple">📅</span> Horarios Disponibles
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        {cn.availability.days.map((d, i) => (
                          <span key={i} className="text-xs px-2 py-1 bg-neon-purple/20 text-neon-purple rounded">
                            {DAYS[d.day]} {d.start}-{d.end}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {cn.files && (
                    <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
                      <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                        <span className="text-accent-warning">📁</span> Archivos del Agente ({cn.files.count})
                      </h4>
                      <div className="space-y-1">
                        {cn.files.files.slice(0, 5).map((f, i) => (
                          <div key={i} className="text-xs text-gray-300 truncate">{f.name}</div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
                    <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                      <span className="text-neon-blue">📚</span> Secciones Core ({cn.sections.core.length})
                    </h4>
                    {cn.sections.core.length > 0 ? (
                      <div className="space-y-2">
                        {cn.sections.core.map((s, i) => (
                          <div key={i} className="text-xs">
                            <div className="text-gray-300 font-medium">{s.title}</div>
                            <div className="text-gray-500 italic truncate">{s.contentPreview}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500">Sin secciones core</p>
                    )}
                  </div>

                  <div className="bg-dark-card rounded-lg p-4 border border-dark-border">
                    <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                      <span className="text-accent-success">🔍</span> Secciones RAG ({cn.sections.rag.length})
                    </h4>
                    {cn.sections.rag.length > 0 ? (
                      <div className="space-y-2">
                        {cn.sections.rag.slice(0, 3).map((s, i) => (
                          <div key={i} className="flex justify-between text-xs">
                            <span className="text-gray-300">{s.title}</span>
                            <span className={s.hasEmbedding ? 'text-accent-success' : 'text-accent-warning'}>
                              {s.hasEmbedding ? '✓ embedding' : '⚠ sin embedding'}
                            </span>
                          </div>
                        ))}
                        {cn.sections.rag.length > 3 && <p className="text-xs text-gray-500">+ {cn.sections.rag.length - 3} mas...</p>}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500">Sin secciones RAG</p>
                    )}
                  </div>

                  {cn.customTools.length > 0 && (
                    <div className="bg-dark-card rounded-lg p-4 border border-dark-border md:col-span-2">
                      <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                        <span className="text-accent-purple">🛠️</span> Herramientas Personalizadas ({cn.customTools.length})
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {cn.customTools.map((t, i) => (
                          <div key={i} className="bg-dark-hover rounded p-2">
                            <div className="text-xs text-white font-medium">{t.name}</div>
                            <div className="text-xs text-gray-400">{t.description}</div>
                            <div className="text-xs text-gray-500 truncate">{t.method} → {t.endpoint}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="bg-dark-card rounded-lg p-4 border border-dark-border md:col-span-2">
                    <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                      <span className="text-neon-blue">⚙️</span> Configuracion General
                    </h4>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                      <div>
                        <span className="text-gray-400">Suscripcion:</span>
                        <span className="text-white ml-2">{cn.subscription.tier}</span>
                      </div>
                      <div>
                        <span className="text-gray-400">Estado:</span>
                        <span className="text-white ml-2">{cn.subscription.status}</span>
                      </div>
                      <div>
                        <span className="text-gray-400">Moneda:</span>
                        <span className="text-white ml-2">{health.currencyCode}</span>
                      </div>
                      <div>
                        <span className="text-gray-400">WhatsApp:</span>
                        <span className="text-white ml-2">{cn.instance?.provider || 'No conectado'}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="text-center pt-2">
              <button
                onClick={fetchHealth}
                className="text-sm text-gray-400 hover:text-white transition-colors"
              >
                🔄 Actualizar
              </button>
            </div>
          </div>
        ) : (
          <div className="p-8 text-center text-gray-400">Error al cargar datos</div>
        )}
      </div>
    </div>
  );
}

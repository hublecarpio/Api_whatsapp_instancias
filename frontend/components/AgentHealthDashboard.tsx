'use client';

import { useState, useEffect } from 'react';
import { agentHealthApi } from '@/lib/api';

interface ToolInfo {
  name: string;
  type: 'builtin' | 'custom';
  description: string;
  endpoint?: string;
  reason?: string;
}

interface ContextItem {
  name: string;
  description: string;
  count?: number;
  files?: string[];
}

interface AgentHealth {
  objective: string;
  objectiveLabel: string;
  model: string;
  botEnabled: boolean;
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
  };
}

export default function AgentHealthDashboard({ businessId }: { businessId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState<AgentHealth | null>(null);

  const fetchHealth = async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      const response = await agentHealthApi.get(businessId);
      setHealth(response.data);
    } catch (error) {
      console.error('Failed to fetch agent health:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && !health) {
      fetchHealth();
    }
  }, [isOpen, businessId]);

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

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-surface border border-dark-border rounded-xl w-full max-w-3xl max-h-[85vh] overflow-auto">
        <div className="sticky top-0 bg-dark-surface border-b border-dark-border p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🧠</span>
            <div>
              <h2 className="text-lg font-semibold text-white">Estado del Agente IA</h2>
              <p className="text-xs text-gray-400">Herramientas y contexto activo</p>
            </div>
          </div>
          <button
            onClick={() => setIsOpen(false)}
            className="text-gray-400 hover:text-white text-xl px-2"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-gray-400">Cargando...</div>
        ) : health ? (
          <div className="p-4 space-y-6">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
              <div className="bg-dark-card rounded-lg p-3 text-center border border-dark-border">
                <div className="text-2xl mb-1">🤖</div>
                <div className="text-xs text-gray-400">Modelo</div>
                <div className="text-sm text-white truncate" title={health.model}>{health.model}</div>
              </div>
            </div>

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

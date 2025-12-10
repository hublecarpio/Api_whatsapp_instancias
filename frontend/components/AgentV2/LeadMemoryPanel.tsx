'use client';

import { useState } from 'react';

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

interface LeadMemoryPanelProps {
  memories: LeadMemory[];
  loading: boolean;
  onRefresh: () => void;
  onSelectLead?: (leadId: string) => void;
}

export default function LeadMemoryPanel({ memories, loading, onRefresh, onSelectLead }: LeadMemoryPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedLead, setExpandedLead] = useState<string | null>(null);

  const filteredMemories = memories.filter(m => 
    m.phone.includes(searchQuery) || 
    m.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    m.stage?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Memoria de Leads</h2>
          <p className="text-sm text-gray-400">
            Informacion que el agente recuerda de cada contacto
          </p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="btn btn-secondary btn-sm"
        >
          {loading ? '...' : '🔄'}
        </button>
      </div>

      <div className="mb-4">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Buscar por telefono, nombre o etapa..."
          className="input"
        />
      </div>

      {loading ? (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-neon-purple mx-auto"></div>
        </div>
      ) : filteredMemories.length === 0 ? (
        <div className="text-center py-8">
          <div className="text-4xl mb-2">🧠</div>
          <p className="text-gray-400">No hay memorias de leads guardadas.</p>
          <p className="text-sm text-gray-500">El agente V2 ira guardando informacion a medida que interactue con clientes.</p>
        </div>
      ) : (
        <div className="space-y-3 max-h-[500px] overflow-y-auto">
          {filteredMemories.map(memory => (
            <div
              key={memory.leadId}
              className="border border-dark-hover rounded-lg overflow-hidden"
            >
              <button
                onClick={() => setExpandedLead(expandedLead === memory.leadId ? null : memory.leadId)}
                className="w-full flex items-center justify-between p-3 hover:bg-dark-hover/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-neon-purple/20 flex items-center justify-center text-neon-purple font-medium">
                    {memory.name?.[0]?.toUpperCase() || memory.phone.slice(-2)}
                  </div>
                  <div className="text-left">
                    <p className="font-medium text-white">
                      {memory.name || memory.phone}
                    </p>
                    <p className="text-sm text-gray-400">{memory.phone}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {memory.stage && (
                    <span className="px-2 py-1 bg-neon-blue/20 text-neon-blue rounded text-xs">
                      {memory.stage}
                    </span>
                  )}
                  <span className={`transform transition-transform ${expandedLead === memory.leadId ? 'rotate-180' : ''}`}>
                    ▼
                  </span>
                </div>
              </button>

              {expandedLead === memory.leadId && (
                <div className="p-3 border-t border-dark-hover bg-dark-hover/30 space-y-3">
                  {memory.preferences.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-gray-400 mb-1">Preferencias detectadas:</p>
                      <div className="flex flex-wrap gap-1">
                        {memory.preferences.map((pref, i) => (
                          <span key={i} className="px-2 py-0.5 bg-amber-500/20 text-amber-500 rounded text-xs">
                            {pref}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {Object.keys(memory.collectedData).length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-gray-400 mb-1">Datos recopilados:</p>
                      <div className="grid grid-cols-2 gap-2">
                        {Object.entries(memory.collectedData).map(([key, value]) => (
                          <div key={key} className="text-xs">
                            <span className="text-gray-500">{key}:</span>{' '}
                            <span className="text-white">{value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {memory.notes.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-gray-400 mb-1">Notas:</p>
                      <ul className="text-xs text-gray-300 space-y-1">
                        {memory.notes.map((note, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="text-gray-500">•</span>
                            <span>{note}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {memory.lastInteraction && (
                    <p className="text-xs text-gray-500">
                      Ultima interaccion: {new Date(memory.lastInteraction).toLocaleString()}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

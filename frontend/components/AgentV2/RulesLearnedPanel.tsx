'use client';

import { useState } from 'react';

interface LearnedRule {
  id: string;
  rule: string;
  source: string;
  enabled: boolean;
  createdAt: string;
  appliedCount?: number;
}

interface RulesLearnedPanelProps {
  rules: LearnedRule[];
  loading: boolean;
  onToggleRule: (ruleId: string, enabled: boolean) => void;
  onDeleteRule: (ruleId: string) => void;
  onRefresh: () => void;
}

export default function RulesLearnedPanel({ 
  rules, 
  loading, 
  onToggleRule, 
  onDeleteRule,
  onRefresh 
}: RulesLearnedPanelProps) {
  const [showDisabled, setShowDisabled] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const filteredRules = showDisabled ? rules : rules.filter(r => r.enabled);
  const disabledCount = rules.filter(r => !r.enabled).length;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Reglas Aprendidas</h2>
          <p className="text-sm text-gray-400">
            Reglas generadas por el Refinador basadas en interacciones
          </p>
        </div>
        <div className="flex items-center gap-2">
          {disabledCount > 0 && (
            <button
              onClick={() => setShowDisabled(!showDisabled)}
              className={`btn btn-sm ${showDisabled ? 'btn-primary' : 'btn-secondary'}`}
            >
              {showDisabled ? 'Ocultar desactivadas' : `Ver desactivadas (${disabledCount})`}
            </button>
          )}
          <button
            onClick={onRefresh}
            disabled={loading}
            className="btn btn-secondary btn-sm"
          >
            {loading ? '...' : '🔄'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-neon-purple mx-auto"></div>
        </div>
      ) : filteredRules.length === 0 ? (
        <div className="text-center py-8">
          <div className="text-4xl mb-2">✨</div>
          <p className="text-gray-400">No hay reglas aprendidas todavia.</p>
          <p className="text-sm text-gray-500">
            El Refinador generara reglas automaticamente basadas en patrones exitosos de conversacion.
          </p>
        </div>
      ) : (
        <div className="space-y-3 max-h-[500px] overflow-y-auto">
          {filteredRules.map(rule => (
            <div
              key={rule.id}
              className={`p-4 rounded-lg border transition-colors ${
                rule.enabled
                  ? 'border-neon-purple/30 bg-neon-purple/5'
                  : 'border-dark-hover bg-dark-hover/30 opacity-60'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <p className="text-white font-medium mb-1">{rule.rule}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                    <span className="flex items-center gap-1">
                      <span className="text-gray-500">Origen:</span>
                      <span className="px-2 py-0.5 bg-dark-hover rounded">
                        {rule.source}
                      </span>
                    </span>
                    <span className="text-gray-500">•</span>
                    <span>
                      {new Date(rule.createdAt).toLocaleDateString()}
                    </span>
                    {rule.appliedCount !== undefined && (
                      <>
                        <span className="text-gray-500">•</span>
                        <span>Aplicada {rule.appliedCount} veces</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onToggleRule(rule.id, !rule.enabled)}
                    className={`relative inline-flex h-6 w-10 items-center rounded-full transition-colors ${
                      rule.enabled ? 'bg-neon-purple' : 'bg-dark-hover'
                    }`}
                    title={rule.enabled ? 'Desactivar regla' : 'Activar regla'}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        rule.enabled ? 'translate-x-5' : 'translate-x-1'
                      }`}
                    />
                  </button>

                  {confirmDelete === rule.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => {
                          onDeleteRule(rule.id);
                          setConfirmDelete(null);
                        }}
                        className="btn btn-danger btn-sm"
                      >
                        Si
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="btn btn-secondary btn-sm"
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(rule.id)}
                      className="text-gray-400 hover:text-accent-error transition-colors"
                      title="Eliminar regla"
                    >
                      🗑️
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 p-3 bg-dark-hover/50 rounded-lg">
        <p className="text-xs text-gray-400">
          <strong className="text-neon-purple">Tip:</strong> Las reglas desactivadas no se aplicaran en futuras conversaciones pero se mantendran para referencia. El sistema aprende de cada interaccion y mejora continuamente.
        </p>
      </div>
    </div>
  );
}

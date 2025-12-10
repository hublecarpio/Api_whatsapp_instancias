'use client';

import { useState } from 'react';

interface PromptsV2PanelProps {
  prompts: {
    vendor: string;
    observer: string;
    refiner: string;
  };
  onUpdatePrompts: (prompts: PromptsV2PanelProps['prompts']) => void;
  loading: boolean;
}

const DEFAULT_PROMPTS = {
  vendor: `Eres un agente de ventas experto. Tu objetivo es:
- Entender las necesidades del cliente
- Recomendar productos adecuados
- Responder preguntas con precision
- Guiar hacia la compra cuando sea apropiado
- Usar las herramientas disponibles cuando sea necesario`,
  observer: `Eres un observador analitico. Tu rol es:
- Detectar fallas en las respuestas del vendedor
- Identificar objeciones no resueltas del cliente
- Sugerir mejoras para futuras interacciones
- Evaluar el tono y efectividad de la comunicacion`,
  refiner: `Eres un optimizador de reglas. Tu funcion es:
- Generar nuevas reglas basadas en patrones exitosos
- Identificar comportamientos a evitar
- Crear directrices especificas para este negocio
- Mejorar continuamente las respuestas del agente`
};

export default function PromptsV2Panel({ prompts, onUpdatePrompts, loading }: PromptsV2PanelProps) {
  const [activePrompt, setActivePrompt] = useState<'vendor' | 'observer' | 'refiner'>('vendor');
  const [localPrompts, setLocalPrompts] = useState(prompts);

  const handleChange = (key: 'vendor' | 'observer' | 'refiner', value: string) => {
    setLocalPrompts(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    onUpdatePrompts(localPrompts);
  };

  const handleRestore = (key: 'vendor' | 'observer' | 'refiner') => {
    setLocalPrompts(prev => ({ ...prev, [key]: DEFAULT_PROMPTS[key] }));
  };

  const tabs = [
    { key: 'vendor' as const, label: 'Vendedor', icon: '🧠', color: 'neon-blue' },
    { key: 'observer' as const, label: 'Observador', icon: '👁️', color: 'amber-500' },
    { key: 'refiner' as const, label: 'Refinador', icon: '✨', color: 'neon-purple' }
  ];

  return (
    <div className="card">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-white">Prompts de los 3 Cerebros</h2>
        <p className="text-sm text-gray-400">
          Personaliza el comportamiento de cada agente del sistema multi-cerebro
        </p>
      </div>

      <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActivePrompt(tab.key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors whitespace-nowrap ${
              activePrompt === tab.key
                ? `bg-${tab.color}/20 text-${tab.color} border border-${tab.color}/30`
                : 'bg-dark-hover text-gray-400 hover:text-white'
            }`}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="space-y-4">
        <div className="p-3 bg-dark-hover/50 rounded-lg">
          <p className="text-sm text-gray-300">
            {activePrompt === 'vendor' && (
              <>
                <strong className="text-neon-blue">Cerebro 1 - Vendedor:</strong> Interpreta mensajes del cliente, decide respuestas o acciones, y ejecuta herramientas.
              </>
            )}
            {activePrompt === 'observer' && (
              <>
                <strong className="text-amber-500">Cerebro 2 - Observador:</strong> Analiza las respuestas del vendedor, detecta fallas y sugiere mejoras.
              </>
            )}
            {activePrompt === 'refiner' && (
              <>
                <strong className="text-neon-purple">Cerebro 3 - Refinador:</strong> Genera reglas dinamicas basadas en patrones de exito para mejorar continuamente.
              </>
            )}
          </p>
        </div>

        <textarea
          value={localPrompts[activePrompt]}
          onChange={(e) => handleChange(activePrompt, e.target.value)}
          className="input font-mono text-sm resize-none"
          rows={10}
          placeholder={`Instrucciones para el agente ${activePrompt}...`}
        />

        <div className="flex flex-col sm:flex-row justify-between gap-3">
          <button
            onClick={() => handleRestore(activePrompt)}
            className="btn btn-secondary"
          >
            Restaurar por defecto
          </button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="btn btn-primary"
          >
            {loading ? 'Guardando...' : 'Guardar Prompts'}
          </button>
        </div>
      </div>
    </div>
  );
}

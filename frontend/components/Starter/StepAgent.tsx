'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { promptApi } from '@/lib/api';

interface StepAgentProps {
  businessId: string;
  businessName: string;
  onComplete: () => void;
  onSkip: () => void;
}

const TEMPLATES = [
  {
    id: 'tienda',
    label: '🛍️ Tienda Online',
    prompt: 'Eres un asistente de ventas amigable para {businessName}. Ayudas a los clientes a encontrar productos, respondes preguntas sobre precios y disponibilidad, y guías el proceso de compra. Siempre sé cordial y profesional.'
  },
  {
    id: 'servicios',
    label: '💼 Servicios',
    prompt: 'Eres el asistente virtual de {businessName}. Tu trabajo es informar sobre los servicios disponibles, responder consultas frecuentes y ayudar a agendar citas. Mantén un tono profesional pero cercano.'
  },
  {
    id: 'restaurante',
    label: '🍽️ Restaurante',
    prompt: 'Eres el asistente de {businessName}. Ayudas a los clientes con el menú, precios, horarios y pedidos. Recomienda platos populares cuando te pregunten. Sé amable y hazlos sentir bienvenidos.'
  },
  {
    id: 'custom',
    label: '✏️ Personalizado',
    prompt: ''
  }
];

export default function StepAgent({ businessId, businessName, onComplete, onSkip }: StepAgentProps) {
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getPrompt = () => {
    if (selectedTemplate === 'custom') {
      return customPrompt;
    }
    const template = TEMPLATES.find(t => t.id === selectedTemplate);
    return template?.prompt.replace('{businessName}', businessName) || '';
  };

  const handleSave = async () => {
    const prompt = getPrompt();
    
    if (!prompt.trim()) {
      setError('Por favor escribe o selecciona una instrucción para el asistente');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await promptApi.save({
        businessId,
        prompt: prompt.trim()
      });
      
      setTimeout(onComplete, 500);
    } catch (err: any) {
      console.error('Error saving prompt:', err);
      setError(err.response?.data?.error || 'Error al guardar la configuración');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 className="text-xl font-semibold text-white mb-2 text-center">Configura tu asistente IA</h2>
      <p className="text-gray-400 mb-6 text-center">Elige una plantilla o escribe instrucciones personalizadas</p>

      <div className="max-w-lg mx-auto">
        <div className="grid grid-cols-2 gap-3 mb-6">
          {TEMPLATES.map(template => (
            <motion.button
              key={template.id}
              onClick={() => {
                setSelectedTemplate(template.id);
                if (template.id !== 'custom') {
                  setCustomPrompt('');
                }
              }}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className={`p-4 rounded-xl border-2 text-left transition ${
                selectedTemplate === template.id
                  ? 'border-indigo-500 bg-indigo-500/10'
                  : 'border-gray-700 bg-[#12121f] hover:border-gray-600'
              }`}
            >
              <span className="text-lg">{template.label}</span>
            </motion.button>
          ))}
        </div>

        {selectedTemplate && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
          >
            {selectedTemplate === 'custom' ? (
              <textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="Describe cómo quieres que se comporte tu asistente..."
                rows={5}
                className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:border-indigo-500 focus:outline-none resize-none"
              />
            ) : (
              <div className="bg-gray-900/50 border border-gray-700 rounded-xl p-4">
                <p className="text-sm text-gray-400 mb-2">Vista previa:</p>
                <p className="text-white text-sm leading-relaxed">
                  {TEMPLATES.find(t => t.id === selectedTemplate)?.prompt.replace('{businessName}', businessName)}
                </p>
              </div>
            )}
          </motion.div>
        )}

        {error && (
          <p className="text-red-400 text-sm text-center mt-4">{error}</p>
        )}

        <button
          onClick={handleSave}
          disabled={saving || !selectedTemplate}
          className="w-full mt-6 py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {saving ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              Guardando...
            </>
          ) : (
            '🎉 Completar configuración'
          )}
        </button>
      </div>
    </div>
  );
}

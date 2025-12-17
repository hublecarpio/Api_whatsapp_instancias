'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { promptApi, businessApi } from '@/lib/api';
import { useBusinessStore } from '@/store/business';

interface StepAgentProps {
  businessId: string;
  businessName: string;
  onComplete: () => void;
  onSkip: () => void;
}

type BusinessObjective = 'SALES' | 'APPOINTMENTS';

const SALES_TEMPLATES = [
  {
    id: 'tienda',
    label: '🛍️ Tienda Online',
    prompt: 'Eres un asistente de ventas amigable para {businessName}. Ayudas a los clientes a encontrar productos, respondes preguntas sobre precios y disponibilidad, y guias el proceso de compra. Siempre se cordial y profesional.'
  },
  {
    id: 'restaurante',
    label: '🍽️ Restaurante',
    prompt: 'Eres el asistente de {businessName}. Ayudas a los clientes con el menu, precios, horarios y pedidos. Recomienda platos populares cuando te pregunten. Se amable y hazlos sentir bienvenidos.'
  },
  {
    id: 'ecommerce',
    label: '📦 E-commerce',
    prompt: 'Eres el vendedor virtual de {businessName}. Tu objetivo es ayudar a los clientes a encontrar lo que buscan, resolver dudas sobre productos, informar sobre envios y metodos de pago, y cerrar ventas. Se proactivo y amable.'
  }
];

const APPOINTMENTS_TEMPLATES = [
  {
    id: 'servicios',
    label: '💼 Servicios Profesionales',
    prompt: 'Eres el asistente virtual de {businessName}. Tu trabajo es informar sobre los servicios disponibles, responder consultas frecuentes y ayudar a agendar citas. Manten un tono profesional pero cercano.'
  },
  {
    id: 'salud',
    label: '🏥 Salud / Belleza',
    prompt: 'Eres el asistente de {businessName}. Ayudas a los clientes a conocer los servicios, consultar disponibilidad y agendar citas. Se empatico y profesional. Recuerda que la salud y bienestar del cliente es prioridad.'
  },
  {
    id: 'consultoria',
    label: '📋 Consultoria',
    prompt: 'Eres el asistente de {businessName}. Ayudas a potenciales clientes a entender los servicios de consultoria, respondes preguntas frecuentes y agendas reuniones de descubrimiento. Se profesional y orientado a soluciones.'
  }
];

export default function StepAgent({ businessId, businessName, onComplete, onSkip }: StepAgentProps) {
  const [objective, setObjective] = useState<BusinessObjective | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { updateBusiness } = useBusinessStore();

  const templates = objective === 'SALES' ? SALES_TEMPLATES : APPOINTMENTS_TEMPLATES;

  const getPrompt = () => {
    if (selectedTemplate === 'custom') {
      return customPrompt;
    }
    const allTemplates = [...SALES_TEMPLATES, ...APPOINTMENTS_TEMPLATES];
    const template = allTemplates.find(t => t.id === selectedTemplate);
    return template?.prompt.replace('{businessName}', businessName) || '';
  };

  const handleSave = async () => {
    if (!objective) {
      setError('Por favor selecciona el tipo de negocio');
      return;
    }

    const prompt = getPrompt();
    
    if (!prompt.trim() && selectedTemplate !== 'custom') {
      setError('Por favor selecciona una plantilla o escribe instrucciones personalizadas');
      return;
    }

    if (selectedTemplate === 'custom' && !customPrompt.trim()) {
      setError('Por favor escribe las instrucciones para el asistente');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      // Save business objective
      await businessApi.update(businessId, { businessObjective: objective });
      updateBusiness(businessId, { businessObjective: objective } as any);
      
      // Save prompt if selected
      if (prompt.trim()) {
        await promptApi.save({
          businessId,
          prompt: prompt.trim()
        });
      }
      
      setTimeout(onComplete, 500);
    } catch (err: any) {
      console.error('Error saving config:', err);
      setError(err.response?.data?.error || 'Error al guardar la configuracion');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 className="text-xl font-semibold text-white mb-2 text-center">Configura tu asistente IA</h2>
      <p className="text-gray-400 mb-6 text-center">Primero selecciona el tipo de negocio, luego elige una plantilla</p>

      <div className="max-w-lg mx-auto">
        {/* Step 1: Business Objective Selection */}
        <div className="mb-6">
          <p className="text-sm text-gray-400 mb-3 text-center">Que tipo de negocio tienes?</p>
          <div className="grid grid-cols-2 gap-3">
            <motion.button
              onClick={() => {
                setObjective('SALES');
                setSelectedTemplate(null);
              }}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className={`p-4 rounded-xl border-2 text-center transition ${
                objective === 'SALES'
                  ? 'border-green-500 bg-green-500/10'
                  : 'border-gray-700 bg-[#12121f] hover:border-gray-600'
              }`}
            >
              <div className="text-2xl mb-1">🛒</div>
              <div className="font-medium text-white">Ventas</div>
              <div className="text-xs text-gray-500 mt-1">Productos, pedidos, e-commerce</div>
            </motion.button>
            <motion.button
              onClick={() => {
                setObjective('APPOINTMENTS');
                setSelectedTemplate(null);
              }}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className={`p-4 rounded-xl border-2 text-center transition ${
                objective === 'APPOINTMENTS'
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-gray-700 bg-[#12121f] hover:border-gray-600'
              }`}
            >
              <div className="text-2xl mb-1">📅</div>
              <div className="font-medium text-white">Citas</div>
              <div className="text-xs text-gray-500 mt-1">Servicios, reservas, calendario</div>
            </motion.button>
          </div>
        </div>

        {/* Step 2: Template Selection (shows after objective is selected) */}
        {objective && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6"
          >
            <p className="text-sm text-gray-400 mb-3 text-center">Elige una plantilla para tu asistente</p>
            <div className="grid grid-cols-1 gap-3">
              {templates.map(template => (
                <motion.button
                  key={template.id}
                  onClick={() => {
                    setSelectedTemplate(template.id);
                    setCustomPrompt('');
                  }}
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  className={`p-4 rounded-xl border-2 text-left transition ${
                    selectedTemplate === template.id
                      ? 'border-indigo-500 bg-indigo-500/10'
                      : 'border-gray-700 bg-[#12121f] hover:border-gray-600'
                  }`}
                >
                  <span className="text-lg">{template.label}</span>
                  <p className="text-xs text-gray-500 mt-1 line-clamp-2">{template.prompt.replace('{businessName}', businessName)}</p>
                </motion.button>
              ))}
              <motion.button
                onClick={() => setSelectedTemplate('custom')}
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                className={`p-4 rounded-xl border-2 text-left transition ${
                  selectedTemplate === 'custom'
                    ? 'border-indigo-500 bg-indigo-500/10'
                    : 'border-gray-700 bg-[#12121f] hover:border-gray-600'
                }`}
              >
                <span className="text-lg">✏️ Personalizado</span>
                <p className="text-xs text-gray-500 mt-1">Escribe tus propias instrucciones</p>
              </motion.button>
            </div>
          </motion.div>
        )}

        {/* Custom prompt textarea */}
        {selectedTemplate === 'custom' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6"
          >
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="Describe como quieres que se comporte tu asistente..."
              rows={5}
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:border-indigo-500 focus:outline-none resize-none"
            />
          </motion.div>
        )}

        {error && (
          <p className="text-red-400 text-sm text-center mt-4">{error}</p>
        )}

        <button
          onClick={handleSave}
          disabled={saving || !objective || (selectedTemplate === null)}
          className="w-full mt-6 py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {saving ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              Guardando...
            </>
          ) : (
            'Completar configuracion'
          )}
        </button>
      </div>
    </div>
  );
}

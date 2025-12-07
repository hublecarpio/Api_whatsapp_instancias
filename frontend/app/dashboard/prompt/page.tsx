'use client';

import { useState, useEffect } from 'react';
import { useBusinessStore } from '@/store/business';
import { promptApi, businessApi } from '@/lib/api';

const DEFAULT_PROMPT = `Eres un asistente de atención al cliente amable y profesional.

Tu objetivo es ayudar a los clientes con sus consultas, proporcionar información sobre productos y servicios, y resolver cualquier problema que puedan tener.

Directrices:
- Sé siempre cortés y profesional
- Responde de manera clara y concisa
- Si no sabes algo, indícalo honestamente
- Ofrece alternativas cuando sea posible
- Usa el catálogo de productos para dar información precisa`;

export default function PromptPage() {
  const { currentBusiness, updateBusiness } = useBusinessStore();
  const [prompt, setPrompt] = useState('');
  const [promptId, setPromptId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [botEnabled, setBotEnabled] = useState(true);

  useEffect(() => {
    if (currentBusiness) {
      setBotEnabled(currentBusiness.botEnabled);
      
      promptApi.get(currentBusiness.id).then((res) => {
        if (res.data) {
          setPrompt(res.data.prompt);
          setPromptId(res.data.id);
        } else {
          setPrompt(DEFAULT_PROMPT);
        }
      }).catch(() => {
        setPrompt(DEFAULT_PROMPT);
      });
    }
  }, [currentBusiness]);

  const handleSavePrompt = async () => {
    if (!currentBusiness) return;
    
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const response = await promptApi.save({
        businessId: currentBusiness.id,
        prompt
      });
      setPromptId(response.data.id);
      setSuccess('Prompt guardado correctamente');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al guardar prompt');
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

  if (!currentBusiness) {
    return (
      <div className="card text-center py-12">
        <p className="text-gray-600">
          Primero debes crear una empresa para configurar el agente IA.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Agente IA</h1>

      {success && (
        <div className="bg-green-50 text-green-600 px-4 py-3 rounded-lg mb-4">
          {success}
        </div>
      )}
      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg mb-4">
          {error}
        </div>
      )}

      <div className="card mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Estado del Bot</h2>
            <p className="text-sm text-gray-600">
              {botEnabled 
                ? 'El bot responderá automáticamente a los mensajes'
                : 'Los mensajes se registrarán pero no habrá respuesta automática'}
            </p>
          </div>
          <button
            onClick={handleToggleBot}
            disabled={loading}
            className={`px-6 py-3 rounded-full font-medium transition-colors ${
              botEnabled
                ? 'bg-green-600 text-white hover:bg-green-700'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            {botEnabled ? '🤖 Activo' : '😴 Inactivo'}
          </button>
        </div>
      </div>

      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Prompt maestro</h2>
        <p className="text-sm text-gray-600 mb-4">
          Este es el prompt que define cómo se comporta tu agente de IA. 
          El contexto de productos y políticas se añadirá automáticamente.
        </p>
        
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="input font-mono text-sm"
          rows={15}
          placeholder="Escribe las instrucciones para tu agente IA..."
        />

        <div className="flex items-center justify-between mt-4">
          <button
            onClick={() => setPrompt(DEFAULT_PROMPT)}
            className="btn btn-secondary"
          >
            Restaurar por defecto
          </button>
          <button
            onClick={handleSavePrompt}
            disabled={loading || !prompt}
            className="btn btn-primary"
          >
            {loading ? 'Guardando...' : 'Guardar prompt'}
          </button>
        </div>
      </div>

      <div className="card mt-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Configuración de IA</h2>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Modelo:</span>
            <span className="font-medium">{currentBusiness.openaiModel || 'No configurado'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">API Key:</span>
            <span className="font-medium">
              {currentBusiness.openaiModel ? '••••••••' : 'No configurada'}
            </span>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-4">
          Para cambiar la configuración de IA, ve a la sección "Mi Empresa"
        </p>
      </div>
    </div>
  );
}

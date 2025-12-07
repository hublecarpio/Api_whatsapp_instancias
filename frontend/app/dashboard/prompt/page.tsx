'use client';

import { useState, useEffect } from 'react';
import { useBusinessStore } from '@/store/business';
import { promptApi, toolsApi, businessApi } from '@/lib/api';

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
  const [bufferSeconds, setBufferSeconds] = useState(0);
  const [historyLimit, setHistoryLimit] = useState(10);
  const [splitMessages, setSplitMessages] = useState(true);
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [botEnabled, setBotEnabled] = useState(true);
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

  useEffect(() => {
    if (currentBusiness) {
      setBotEnabled(currentBusiness.botEnabled);
      loadData();
    }
  }, [currentBusiness]);

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
        <p className="text-gray-600">
          Primero debes crear una empresa para configurar el agente IA.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
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
                ? 'El bot respondera automaticamente a los mensajes'
                : 'Los mensajes se registraran pero no habra respuesta automatica'}
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
            {botEnabled ? 'Activo' : 'Inactivo'}
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setActiveTab('prompt')}
          className={`px-4 py-2 rounded-lg font-medium ${
            activeTab === 'prompt' ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-700'
          }`}
        >
          Prompt Maestro
        </button>
        <button
          onClick={() => setActiveTab('config')}
          className={`px-4 py-2 rounded-lg font-medium ${
            activeTab === 'config' ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-700'
          }`}
        >
          Configuracion
        </button>
        <button
          onClick={() => setActiveTab('tools')}
          className={`px-4 py-2 rounded-lg font-medium ${
            activeTab === 'tools' ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-700'
          }`}
        >
          Tools ({tools.length})
        </button>
      </div>

      {activeTab === 'prompt' && (
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Prompt maestro</h2>
          <p className="text-sm text-gray-600 mb-4">
            Este es el prompt que define como se comporta tu agente de IA. 
            El contexto de productos y politicas se añadira automaticamente.
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
              {loading ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </div>
      )}

      {activeTab === 'config' && (
        <div className="space-y-6">
          <div className="card">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Buffer de Mensajes</h2>
            <p className="text-sm text-gray-600 mb-4">
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
                className="flex-1"
              />
              <span className="font-mono text-lg w-20 text-center">
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
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Historial de Conversacion</h2>
            <p className="text-sm text-gray-600 mb-4">
              Cantidad de mensajes anteriores que el agente recuerda para dar contexto.
            </p>
            
            <div className="flex items-center gap-4">
              <input
                type="range"
                min="5"
                max="50"
                value={historyLimit}
                onChange={(e) => setHistoryLimit(parseInt(e.target.value))}
                className="flex-1"
              />
              <span className="font-mono text-lg w-20 text-center">
                {historyLimit}
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              El agente recordara los ultimos {historyLimit} mensajes de la conversacion
            </p>
          </div>

          <div className="card">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Division de Mensajes</h2>
            <p className="text-sm text-gray-600 mb-4">
              Dividir respuestas largas en multiples mensajes para parecer mas humano.
            </p>
            
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={splitMessages}
                onChange={(e) => setSplitMessages(e.target.checked)}
                className="w-5 h-5 rounded border-gray-300 text-green-600 focus:ring-green-500"
              />
              <span className="text-gray-700">
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

      {activeTab === 'tools' && (
        <div className="space-y-4">
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Tools Externos</h2>
                <p className="text-sm text-gray-600">
                  Agrega endpoints externos que el agente puede usar para obtener informacion.
                </p>
              </div>
              {!showToolForm && (
                <button
                  onClick={() => setShowToolForm(true)}
                  className="btn btn-primary"
                >
                  + Nuevo Tool
                </button>
              )}
            </div>

            {showToolForm && (
              <div className="border border-gray-200 rounded-lg p-4 mb-4 space-y-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-gray-900">
                    {editingTool ? 'Editar Tool' : 'Nuevo Tool'}
                  </h3>
                  <button
                    onClick={handleCancelToolForm}
                    className="text-sm text-gray-500 hover:text-gray-700"
                  >
                    Cancelar
                  </button>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">
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
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
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
                    <label className="block text-sm font-medium text-gray-700 mb-1">
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Body Template (JSON opcional)
                  </label>
                  <textarea
                    value={newTool.bodyTemplate}
                    onChange={(e) => setNewTool({ ...newTool, bodyTemplate: e.target.value })}
                    className="input font-mono text-sm"
                    rows={3}
                    placeholder='{"orderId": "{{orderId}}", "email": "{{email}}"}'
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Usa {"{{paramName}}"} para insertar parametros dinamicos
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-gray-700">
                      Parametros
                    </label>
                    <button
                      type="button"
                      onClick={() => setNewTool({
                        ...newTool,
                        parameters: [...newTool.parameters, { name: '', type: 'string', description: '', required: true }]
                      })}
                      className="text-sm text-green-600 hover:text-green-700"
                    >
                      + Agregar Parametro
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 mb-2">
                    Define los campos que el agente debe extraer para llamar este endpoint.
                  </p>
                  
                  {newTool.parameters.length === 0 ? (
                    <p className="text-xs text-gray-400 italic py-2">
                      Sin parametros (usara "query" por defecto)
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {newTool.parameters.map((param, index) => (
                        <div key={index} className="flex items-start gap-2 p-2 bg-gray-50 rounded">
                          <input
                            type="text"
                            value={param.name}
                            onChange={(e) => {
                              const params = [...newTool.parameters];
                              params[index].name = e.target.value;
                              setNewTool({ ...newTool, parameters: params });
                            }}
                            className="input flex-1 text-sm"
                            placeholder="orderId"
                          />
                          <select
                            value={param.type}
                            onChange={(e) => {
                              const params = [...newTool.parameters];
                              params[index].type = e.target.value;
                              setNewTool({ ...newTool, parameters: params });
                            }}
                            className="input w-24 text-sm"
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
                            className="input flex-1 text-sm"
                            placeholder="Descripcion"
                          />
                          <label className="flex items-center gap-1 text-xs text-gray-600">
                            <input
                              type="checkbox"
                              checked={param.required}
                              onChange={(e) => {
                                const params = [...newTool.parameters];
                                params[index].required = e.target.checked;
                                setNewTool({ ...newTool, parameters: params });
                              }}
                              className="w-4 h-4"
                            />
                            Req
                          </label>
                          <button
                            type="button"
                            onClick={() => {
                              const params = newTool.parameters.filter((_, i) => i !== index);
                              setNewTool({ ...newTool, parameters: params });
                            }}
                            className="text-red-500 hover:text-red-700 px-2"
                          >
                            x
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  onClick={editingTool ? handleUpdateTool : handleCreateTool}
                  disabled={loading || !newTool.name || !newTool.description || !newTool.url}
                  className="btn btn-primary w-full"
                >
                  {loading 
                    ? (editingTool ? 'Actualizando...' : 'Creando...') 
                    : (editingTool ? 'Actualizar Tool' : 'Crear Tool')}
                </button>
              </div>
            )}

            {tools.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                No hay tools configurados
              </div>
            ) : (
              <div className="space-y-3">
                {tools.map((tool) => (
                  <div
                    key={tool.id}
                    className={`border rounded-lg p-4 ${
                      tool.enabled ? 'border-green-200 bg-green-50' : 'border-gray-200'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900">{tool.name}</span>
                          <span className="text-xs px-2 py-0.5 rounded bg-gray-200 text-gray-600">
                            {tool.method}
                          </span>
                        </div>
                        <p className="text-sm text-gray-600 mt-1">{tool.description}</p>
                        <p className="text-xs text-gray-400 mt-1 font-mono">{tool.url}</p>
                        
                        {tool.parameters && tool.parameters.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {tool.parameters.map((param, idx) => (
                              <span
                                key={idx}
                                className={`text-xs px-2 py-0.5 rounded ${
                                  param.required 
                                    ? 'bg-blue-100 text-blue-700' 
                                    : 'bg-gray-100 text-gray-600'
                                }`}
                              >
                                {param.name}: {param.type}
                              </span>
                            ))}
                          </div>
                        )}
                        
                        {testResult && testResult.toolId === tool.id && (
                          <div className="mt-2 p-2 bg-gray-100 rounded text-xs font-mono overflow-auto max-h-32">
                            {testResult.error ? (
                              <span className="text-red-600">{testResult.error}</span>
                            ) : (
                              <pre>{JSON.stringify(testResult.data, null, 2)}</pre>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleViewLogs(tool)}
                          className="text-sm px-3 py-1 text-purple-600 hover:bg-purple-50 rounded"
                        >
                          Historial
                        </button>
                        <button
                          onClick={() => handleEditTool(tool)}
                          className="text-sm px-3 py-1 text-gray-600 hover:bg-gray-100 rounded"
                        >
                          Editar
                        </button>
                        <button
                          onClick={() => handleTestTool(tool)}
                          className="text-sm px-3 py-1 text-blue-600 hover:bg-blue-50 rounded"
                        >
                          Test
                        </button>
                        <button
                          onClick={() => handleToggleTool(tool)}
                          className={`text-sm px-3 py-1 rounded ${
                            tool.enabled 
                              ? 'text-green-600 hover:bg-green-100' 
                              : 'text-gray-500 hover:bg-gray-100'
                          }`}
                        >
                          {tool.enabled ? 'Activo' : 'Inactivo'}
                        </button>
                        <button
                          onClick={() => handleDeleteTool(tool.id)}
                          className="text-sm px-3 py-1 text-red-600 hover:bg-red-50 rounded"
                        >
                          Eliminar
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card mt-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Configuracion de IA</h2>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Modelo:</span>
            <span className="font-medium">{currentBusiness.openaiModel || 'No configurado'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">API Key:</span>
            <span className="font-medium">
              {currentBusiness.openaiApiKey ? '********' : 'No configurada'}
            </span>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-4">
          Para cambiar la configuracion de IA, ve a la seccion "Mi Empresa"
        </p>
      </div>

      {showLogsModal && selectedToolForLogs && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
            <div className="p-4 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  Historial: {selectedToolForLogs.name}
                </h3>
                {toolStats && (
                  <div className="flex gap-4 mt-1 text-sm text-gray-600">
                    <span>Total: <strong>{toolStats.totalCalls}</strong> llamadas</span>
                    <span>Promedio: <strong>{toolStats.avgDuration}ms</strong></span>
                    {toolStats.lastCall && (
                      <span>Ultima: <strong>{new Date(toolStats.lastCall).toLocaleString()}</strong></span>
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={handleCloseLogsModal}
                className="text-gray-500 hover:text-gray-700 text-2xl"
              >
                &times;
              </button>
            </div>
            
            <div className="p-4 overflow-auto max-h-[70vh]">
              {loadingLogs ? (
                <div className="text-center py-8 text-gray-500">Cargando...</div>
              ) : toolLogs.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  No hay registros de uso para este tool
                </div>
              ) : (
                <div className="space-y-3">
                  {toolLogs.map((log) => (
                    <div key={log.id} className="border border-gray-200 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            log.status === 'success' 
                              ? 'bg-green-100 text-green-700' 
                              : 'bg-red-100 text-red-700'
                          }`}>
                            {log.status}
                          </span>
                          {log.duration && (
                            <span className="text-xs text-gray-500">{log.duration}ms</span>
                          )}
                          {log.contactPhone && (
                            <span className="text-xs text-gray-500">Tel: {log.contactPhone}</span>
                          )}
                        </div>
                        <span className="text-xs text-gray-400">
                          {new Date(log.createdAt).toLocaleString()}
                        </span>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <p className="text-xs font-medium text-gray-700 mb-1">Request:</p>
                          <pre className="text-xs bg-gray-50 p-2 rounded overflow-auto max-h-24 font-mono">
                            {JSON.stringify(log.request, null, 2)}
                          </pre>
                        </div>
                        <div>
                          <p className="text-xs font-medium text-gray-700 mb-1">Response:</p>
                          <pre className="text-xs bg-gray-50 p-2 rounded overflow-auto max-h-24 font-mono">
                            {JSON.stringify(log.response, null, 2)}
                          </pre>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

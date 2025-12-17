'use client';

import { useState, useEffect } from 'react';
import { useBusinessStore } from '@/store/business';
import { agentApiKeyApi, agentWebhookApi } from '@/lib/api';

export default function ApiDocsPage() {
  const { currentBusiness } = useBusinessStore();
  const [apiKeyInfo, setApiKeyInfo] = useState<any>(null);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('enviar');

  const [webhookConfig, setWebhookConfig] = useState<{ 
    webhookUrl: string | null; 
    webhookEvents: string[]; 
    webhookSecret: string | null; 
    availableEvents: string[] 
  } | null>(null);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [loadingWebhook, setLoadingWebhook] = useState(false);
  const [webhookSuccess, setWebhookSuccess] = useState<string | null>(null);
  const [webhookError, setWebhookError] = useState<string | null>(null);

  const baseUrl = typeof window !== 'undefined' 
    ? (() => {
        const host = window.location.host;
        // Production: app.efficore.es -> api.efficore.es
        if (host.includes('efficore.es')) {
          return 'https://api.efficore.es';
        }
        // Development: replace frontend port with backend port
        return `${window.location.protocol}//${host.replace(':5000', ':3001')}`;
      })()
    : 'https://api.efficore.es';

  useEffect(() => {
    if (currentBusiness?.id) {
      loadApiKeyInfo();
      loadWebhookConfig();
    }
  }, [currentBusiness?.id]);

  const loadApiKeyInfo = async () => {
    setLoading(true);
    try {
      const response = await agentApiKeyApi.get(currentBusiness!.id);
      setApiKeyInfo(response.data);
    } catch (error) {
      console.error('Error loading API key info:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadWebhookConfig = async () => {
    try {
      const res = await agentWebhookApi.get(currentBusiness!.id);
      setWebhookConfig(res.data);
      setWebhookUrl(res.data.webhookUrl || '');
      setSelectedEvents(res.data.webhookEvents || []);
    } catch (err) {
      console.error('Error loading webhook config:', err);
    }
  };

  const generateApiKey = async () => {
    setGenerating(true);
    try {
      const response = await agentApiKeyApi.create(currentBusiness!.id);
      setNewApiKey(response.data.apiKey);
      setApiKeyInfo({
        hasApiKey: true,
        prefix: response.data.prefix,
        createdAt: response.data.createdAt
      });
    } catch (error: any) {
      alert(error.response?.data?.error || 'Error generando API key');
    } finally {
      setGenerating(false);
    }
  };

  const revokeApiKey = async () => {
    if (!confirm('Estas seguro? Esta accion revocara tu API key actual y deberas generar una nueva.')) {
      return;
    }
    try {
      await agentApiKeyApi.revoke(currentBusiness!.id);
      setApiKeyInfo({ hasApiKey: false });
      setNewApiKey(null);
    } catch (error) {
      console.error('Error revoking API key:', error);
    }
  };

  const handleToggleEvent = (event: string) => {
    setSelectedEvents(prev => 
      prev.includes(event) 
        ? prev.filter(e => e !== event)
        : [...prev, event]
    );
  };

  const handleSaveWebhook = async () => {
    setWebhookError(null);
    setWebhookSuccess(null);
    setLoadingWebhook(true);
    try {
      const res = await agentWebhookApi.update(currentBusiness!.id, {
        webhookUrl: webhookUrl || null,
        webhookEvents: selectedEvents
      });
      setWebhookConfig(res.data);
      setWebhookSuccess('Webhook configurado correctamente');
      setTimeout(() => setWebhookSuccess(null), 3000);
    } catch (err: any) {
      setWebhookError(err.response?.data?.error || 'Error al configurar webhook');
    } finally {
      setLoadingWebhook(false);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const CodeBlock = ({ code, id, language = 'bash' }: { code: string; id: string; language?: string }) => (
    <div className="relative bg-dark-bg rounded-lg border border-dark-border overflow-hidden">
      <div className="flex justify-between items-center px-4 py-2 bg-dark-surface border-b border-dark-border">
        <span className="text-xs text-gray-500">{language}</span>
        <button
          onClick={() => copyToClipboard(code, id)}
          className="text-xs text-gray-400 hover:text-white transition-colors"
        >
          {copied === id ? 'Copiado!' : 'Copiar'}
        </button>
      </div>
      <pre className="p-4 text-sm text-gray-300 overflow-x-auto whitespace-pre-wrap break-all">
        <code>{code}</code>
      </pre>
    </div>
  );

  const tabs = [
    { id: 'enviar', label: 'Enviar Mensaje' },
    { id: 'contactos', label: 'Contactos' },
    { id: 'mensajes', label: 'Mensajes' },
    { id: 'pedidos', label: 'Pedidos' },
    { id: 'citas', label: 'Citas' },
  ];

  const availableEvents = webhookConfig?.availableEvents || [
    'user_message', 
    'agent_message', 
    'state_change', 
    'tool_call', 
    'stage_change'
  ];

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-2">API & Webhooks</h1>
        <p className="text-gray-400">
          Integra tu CRM o sistemas externos con nuestra API. Envia mensajes, consulta contactos y recibe eventos en tiempo real.
        </p>
      </div>

      <div className="bg-dark-surface rounded-xl border border-dark-border p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Tu API Key</h2>
        
        {loading ? (
          <div className="text-gray-400">Cargando...</div>
        ) : apiKeyInfo?.hasApiKey ? (
          <div className="space-y-4">
            {newApiKey ? (
              <div className="bg-accent-success/10 border border-accent-success/30 rounded-lg p-4">
                <p className="text-accent-success text-sm mb-2 font-medium">
                  Guarda esta API key ahora - no podras verla de nuevo:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-dark-bg px-3 py-2 rounded text-white font-mono text-sm break-all">
                    {newApiKey}
                  </code>
                  <button
                    onClick={() => copyToClipboard(newApiKey, 'newkey')}
                    className="px-3 py-2 bg-accent-success text-white rounded hover:bg-accent-success/80 transition-colors text-sm"
                  >
                    {copied === 'newkey' ? 'Copiado!' : 'Copiar'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-4">
                <div>
                  <p className="text-gray-400 text-sm">API Key activa</p>
                  <code className="text-white font-mono">{apiKeyInfo.prefix}...</code>
                </div>
                <span className="text-gray-500 text-sm">
                  Creada: {new Date(apiKeyInfo.createdAt).toLocaleDateString()}
                </span>
              </div>
            )}
            
            <div className="flex gap-2">
              <button
                onClick={generateApiKey}
                disabled={generating}
                className="px-4 py-2 bg-neon-blue text-dark-bg rounded-lg hover:bg-neon-blue/80 transition-colors text-sm"
              >
                {generating ? 'Generando...' : 'Regenerar Key'}
              </button>
              <button
                onClick={revokeApiKey}
                className="px-4 py-2 border border-accent-error text-accent-error rounded-lg hover:bg-accent-error/10 transition-colors text-sm"
              >
                Revocar Key
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-gray-400">No tienes una API key activa.</p>
            <button
              onClick={generateApiKey}
              disabled={generating}
              className="px-4 py-2 bg-neon-blue text-dark-bg rounded-lg hover:bg-neon-blue/80 transition-colors"
            >
              {generating ? 'Generando...' : 'Generar API Key'}
            </button>
          </div>
        )}
      </div>

      <div className="bg-accent-purple/10 border border-accent-purple/30 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Configurar Webhook</h2>
        <p className="text-gray-400 text-sm mb-4">
          Recibe eventos en tiempo real cuando llegan mensajes, el agente responde, o cambia el estado de un contacto.
        </p>

        {webhookSuccess && (
          <div className="mb-4 p-3 bg-accent-success/10 border border-accent-success/30 rounded-lg text-accent-success text-sm">
            {webhookSuccess}
          </div>
        )}
        {webhookError && (
          <div className="mb-4 p-3 bg-accent-error/10 border border-accent-error/30 rounded-lg text-accent-error text-sm">
            {webhookError}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">URL del Webhook</label>
            <input
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://tu-servidor.com/webhook"
              className="w-full px-4 py-2 bg-dark-bg border border-dark-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent-purple/50"
            />
            <p className="text-xs text-gray-500 mt-1">Debe ser HTTPS para produccion</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Eventos a recibir</label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {availableEvents.map(event => (
                <label key={event} className="flex items-center gap-2 p-2 bg-dark-surface rounded-lg cursor-pointer hover:bg-dark-hover border border-dark-border">
                  <input
                    type="checkbox"
                    checked={selectedEvents.includes(event)}
                    onChange={() => handleToggleEvent(event)}
                    className="w-4 h-4 rounded border-gray-600 bg-dark-hover text-accent-purple focus:ring-accent-purple"
                  />
                  <span className="text-sm text-gray-300">{event.replace(/_/g, ' ')}</span>
                </label>
              ))}
            </div>
          </div>

          {webhookConfig?.webhookSecret && (
            <div className="p-3 bg-dark-surface rounded-lg border border-dark-border">
              <p className="text-xs text-gray-400 mb-1">Webhook Secret (para verificar firmas HMAC-SHA256):</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs text-gray-300 font-mono break-all">{webhookConfig.webhookSecret}</code>
                <button
                  onClick={() => copyToClipboard(webhookConfig.webhookSecret!, 'secret')}
                  className="text-xs text-gray-400 hover:text-white"
                >
                  {copied === 'secret' ? 'Copiado!' : 'Copiar'}
                </button>
              </div>
            </div>
          )}

          <button
            onClick={handleSaveWebhook}
            disabled={loadingWebhook}
            className="px-4 py-2 bg-accent-purple text-white rounded-lg hover:bg-accent-purple/80 transition-colors text-sm"
          >
            {loadingWebhook ? 'Guardando...' : 'Guardar Webhook'}
          </button>
        </div>

        <div className="mt-6 pt-4 border-t border-dark-border">
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Formato de Eventos</h3>
          <div className="text-xs text-gray-400 space-y-1">
            <p><code className="text-accent-purple">user_message</code> - Cuando un usuario envia un mensaje (texto, imagenes, audio, video)</p>
            <p><code className="text-accent-purple">agent_message</code> - Cuando el agente responde (incluye respuesta y media enviada)</p>
            <p><code className="text-accent-purple">state_change</code> - Cuando cambia el estado del cliente (etapa, tags)</p>
            <p><code className="text-accent-purple">tool_call</code> - Cuando el agente ejecuta una herramienta</p>
            <p><code className="text-accent-purple">stage_change</code> - Cuando el cliente avanza de etapa</p>
          </div>
        </div>

        <div className="mt-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Ejemplo de Payload</h3>
          <CodeBlock
            id="webhook-example"
            language="json"
            code={`{
  "event": "user_message",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "businessId": "abc123",
  "data": {
    "contactPhone": "5215512345678",
    "contactName": "Juan Perez",
    "message": "Hola, quiero informacion",
    "messageType": "text"
  }
}`}
          />
        </div>
      </div>

      <div className="bg-dark-surface rounded-xl border border-dark-border p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Autenticacion</h2>
        <p className="text-gray-400 mb-4">
          Todas las peticiones deben incluir tu API key en el header Authorization:
        </p>
        <CodeBlock 
          id="auth"
          code={`Authorization: Bearer ${newApiKey || apiKeyInfo?.prefix ? `${apiKeyInfo?.prefix || 'efk_'}...tu_api_key` : 'efk_tu_api_key_aqui'}`}
        />
      </div>

      <div className="bg-dark-surface rounded-xl border border-dark-border overflow-hidden">
        <div className="flex border-b border-dark-border overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
                activeTab === tab.id
                  ? 'text-neon-blue border-b-2 border-neon-blue bg-dark-hover'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-6 space-y-6">
          {activeTab === 'enviar' && (
            <>
              <div>
                <h3 className="text-white font-medium mb-2">POST /api/v1/send-message</h3>
                <p className="text-gray-400 text-sm mb-4">Envia un mensaje de WhatsApp a un numero.</p>
              </div>

              <div>
                <h4 className="text-gray-300 text-sm mb-2">Enviar texto:</h4>
                <CodeBlock
                  id="send-text"
                  code={`curl -X POST "${baseUrl}/api/v1/send-message" \\
  -H "Authorization: Bearer efk_tu_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "5215512345678",
    "message": "Hola! Este es un mensaje desde la API"
  }'`}
                />
              </div>

              <div>
                <h4 className="text-gray-300 text-sm mb-2">Enviar imagen:</h4>
                <CodeBlock
                  id="send-image"
                  code={`curl -X POST "${baseUrl}/api/v1/send-message" \\
  -H "Authorization: Bearer efk_tu_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "5215512345678",
    "message": "Mira esta imagen!",
    "mediaUrl": "https://ejemplo.com/imagen.jpg",
    "mediaType": "image"
  }'`}
                />
              </div>

              <div className="bg-dark-bg rounded-lg p-4">
                <h4 className="text-white text-sm mb-2">Parametros:</h4>
                <ul className="text-gray-400 text-sm space-y-1">
                  <li><code className="text-neon-blue">to</code> (requerido) - Numero de telefono con codigo de pais</li>
                  <li><code className="text-neon-blue">message</code> - Texto del mensaje</li>
                  <li><code className="text-neon-blue">mediaUrl</code> - URL del archivo multimedia</li>
                  <li><code className="text-neon-blue">mediaType</code> - Tipo: image, video, audio, document</li>
                </ul>
              </div>
            </>
          )}

          {activeTab === 'contactos' && (
            <>
              <div>
                <h3 className="text-white font-medium mb-2">GET /api/v1/contacts</h3>
                <p className="text-gray-400 text-sm mb-4">Obtiene la lista de contactos.</p>
              </div>

              <CodeBlock
                id="get-contacts"
                code={`curl -X GET "${baseUrl}/api/v1/contacts?limit=50&search=Juan" \\
  -H "Authorization: Bearer efk_tu_api_key"`}
              />

              <div>
                <h3 className="text-white font-medium mb-2 mt-6">GET /api/v1/contacts/:phone</h3>
                <p className="text-gray-400 text-sm mb-4">Obtiene detalles de un contacto especifico.</p>
              </div>

              <CodeBlock
                id="get-contact"
                code={`curl -X GET "${baseUrl}/api/v1/contacts/5215512345678" \\
  -H "Authorization: Bearer efk_tu_api_key"`}
              />

              <div>
                <h3 className="text-white font-medium mb-2 mt-6">PATCH /api/v1/contacts/:phone</h3>
                <p className="text-gray-400 text-sm mb-4">Actualiza un contacto.</p>
              </div>

              <CodeBlock
                id="update-contact"
                code={`curl -X PATCH "${baseUrl}/api/v1/contacts/5215512345678" \\
  -H "Authorization: Bearer efk_tu_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Juan Perez",
    "email": "juan@ejemplo.com",
    "tags": ["VIP", "Cliente"],
    "notes": "Cliente frecuente"
  }'`}
              />
            </>
          )}

          {activeTab === 'mensajes' && (
            <>
              <div>
                <h3 className="text-white font-medium mb-2">GET /api/v1/messages/:phone</h3>
                <p className="text-gray-400 text-sm mb-4">Obtiene el historial de mensajes con un contacto.</p>
              </div>

              <CodeBlock
                id="get-messages"
                code={`curl -X GET "${baseUrl}/api/v1/messages/5215512345678?limit=50" \\
  -H "Authorization: Bearer efk_tu_api_key"`}
              />
            </>
          )}

          {activeTab === 'pedidos' && (
            <>
              <div>
                <h3 className="text-white font-medium mb-2">GET /api/v1/orders</h3>
                <p className="text-gray-400 text-sm mb-4">Obtiene la lista de pedidos.</p>
              </div>

              <CodeBlock
                id="get-orders"
                code={`curl -X GET "${baseUrl}/api/v1/orders?limit=50&status=PENDING_PAYMENT" \\
  -H "Authorization: Bearer efk_tu_api_key"`}
              />

              <div className="bg-dark-bg rounded-lg p-4 mt-4">
                <h4 className="text-white text-sm mb-2">Estados disponibles:</h4>
                <ul className="text-gray-400 text-sm space-y-1">
                  <li><code className="text-yellow-400">PENDING_PAYMENT</code> - Pendiente de pago</li>
                  <li><code className="text-blue-400">AWAITING_VOUCHER</code> - Esperando comprobante</li>
                  <li><code className="text-green-400">PAID</code> - Pagado</li>
                  <li><code className="text-purple-400">PROCESSING</code> - En proceso</li>
                  <li><code className="text-cyan-400">SHIPPED</code> - Enviado</li>
                  <li><code className="text-accent-success">DELIVERED</code> - Entregado</li>
                </ul>
              </div>
            </>
          )}

          {activeTab === 'citas' && (
            <>
              <div>
                <h3 className="text-white font-medium mb-2">GET /api/v1/appointments</h3>
                <p className="text-gray-400 text-sm mb-4">Obtiene la lista de citas.</p>
              </div>

              <CodeBlock
                id="get-appointments"
                code={`curl -X GET "${baseUrl}/api/v1/appointments?limit=50&status=PENDING" \\
  -H "Authorization: Bearer efk_tu_api_key"`}
              />

              <CodeBlock
                id="get-appointments-range"
                code={`# Filtrar por rango de fechas
curl -X GET "${baseUrl}/api/v1/appointments?from=2024-01-01&to=2024-12-31" \\
  -H "Authorization: Bearer efk_tu_api_key"`}
              />
            </>
          )}
        </div>
      </div>

      <div className="bg-dark-surface rounded-xl border border-dark-border p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Respuestas de la API</h2>
        
        <div className="space-y-4">
          <div>
            <h4 className="text-green-400 text-sm mb-2">Exito (200):</h4>
            <CodeBlock
              id="success"
              language="json"
              code={`{
  "success": true,
  "messageId": "ABC123",
  "to": "5215512345678"
}`}
            />
          </div>

          <div>
            <h4 className="text-red-400 text-sm mb-2">Error de autenticacion (401):</h4>
            <CodeBlock
              id="error-401"
              language="json"
              code={`{
  "error": "API key requerida",
  "hint": "Incluye tu API key en el header: Authorization: Bearer efk_..."
}`}
            />
          </div>

          <div>
            <h4 className="text-yellow-400 text-sm mb-2">Error de plan (403):</h4>
            <CodeBlock
              id="error-403"
              language="json"
              code={`{
  "error": "Esta API requiere plan PRO o superior",
  "tier": "BASIC"
}`}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

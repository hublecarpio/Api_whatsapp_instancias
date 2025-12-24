'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function ApiDocsPage() {
  const [copied, setCopied] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('enviar');

  const baseUrl = typeof window !== 'undefined' 
    ? (() => {
        const host = window.location.host;
        if (host.includes('efficore.es')) {
          return 'https://api.efficore.es';
        }
        return `${window.location.protocol}//${host.replace(':5000', ':3001')}`;
      })()
    : 'https://api.efficore.es';

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
    { id: 'webhooks', label: 'Webhooks' },
  ];

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-2">Documentacion API</h1>
        <p className="text-gray-400">
          Integra tu CRM o sistemas externos con nuestra API. Envia mensajes, consulta contactos y recibe eventos en tiempo real.
        </p>
      </div>

      <div className="bg-neon-blue/10 border border-neon-blue/30 rounded-xl p-4">
        <p className="text-gray-300 text-sm">
          <span className="text-neon-blue font-medium">Configuracion de credenciales:</span>{' '}
          Genera tu API Key y configura webhooks desde la seccion de{' '}
          <Link href="/dashboard/whatsapp" className="text-neon-blue hover:underline">
            WhatsApp
          </Link>
          {' '}en la pestana "API" de cada instancia.
        </p>
      </div>

      <div className="bg-dark-surface rounded-xl border border-dark-border p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Autenticacion</h2>
        <p className="text-gray-400 mb-4">
          Todas las peticiones deben incluir tu API key en el header Authorization:
        </p>
        <CodeBlock 
          id="auth"
          code={`Authorization: Bearer efk_tu_api_key_aqui`}
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

          {activeTab === 'webhooks' && (
            <>
              <div>
                <h3 className="text-white font-medium mb-2">Eventos Disponibles</h3>
                <p className="text-gray-400 text-sm mb-4">
                  Configura tu URL de webhook en la seccion de WhatsApp para recibir estos eventos en tiempo real.
                </p>
              </div>

              <div className="bg-dark-bg rounded-lg p-4 mb-4">
                <ul className="text-gray-400 text-sm space-y-2">
                  <li><code className="text-accent-purple">user_message</code> - Cuando un usuario envia un mensaje (texto, imagenes, audio, video)</li>
                  <li><code className="text-accent-purple">agent_message</code> - Cuando el agente responde (incluye respuesta y media enviada)</li>
                  <li><code className="text-accent-purple">state_change</code> - Cuando cambia el estado del cliente (etapa, tags)</li>
                  <li><code className="text-accent-purple">tool_call</code> - Cuando el agente ejecuta una herramienta</li>
                  <li><code className="text-accent-purple">stage_change</code> - Cuando el cliente avanza de etapa</li>
                </ul>
              </div>

              <div>
                <h4 className="text-gray-300 text-sm mb-2">Ejemplo de Payload:</h4>
                <CodeBlock
                  id="webhook-example"
                  language="json"
                  code={`{
  "event": "user_message",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "businessId": "abc123",
  "instanceId": "inst_123",
  "data": {
    "contactPhone": "5215512345678",
    "contactName": "Juan Perez",
    "message": "Hola, quiero informacion",
    "messageType": "text"
  }
}`}
                />
              </div>

              <div className="mt-4">
                <h4 className="text-gray-300 text-sm mb-2">Verificacion de Firma (HMAC-SHA256):</h4>
                <p className="text-gray-400 text-sm mb-2">
                  Cada webhook incluye un header <code className="text-neon-blue">X-Webhook-Signature</code> que puedes usar para verificar la autenticidad.
                </p>
                <CodeBlock
                  id="verify-signature"
                  language="javascript"
                  code={`const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  return signature === expected;
}`}
                />
              </div>
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

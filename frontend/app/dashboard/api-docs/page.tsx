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
    { id: 'plantillas', label: 'Plantillas' },
    { id: 'agente', label: 'Agente IA' },
    { id: 'contactos', label: 'Contactos' },
    { id: 'productos', label: 'Productos' },
    { id: 'recordatorios', label: 'Recordatorios' },
    { id: 'mensajes', label: 'Mensajes' },
    { id: 'pedidos', label: 'Pedidos' },
    { id: 'citas', label: 'Citas' },
    { id: 'negocio', label: 'Negocio' },
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

          {activeTab === 'plantillas' && (
            <>
              <div className="bg-yellow-900/20 border border-yellow-600/30 rounded-lg p-4 mb-4">
                <p className="text-yellow-300 text-sm">
                  Las plantillas son requeridas para mensajes fuera de la ventana de 24 horas en Meta Cloud y Meta Coexist.
                  Deben estar aprobadas por Meta antes de poder usarse.
                </p>
              </div>

              <div>
                <h3 className="text-white font-medium mb-2">GET /api/v1/templates</h3>
                <p className="text-gray-400 text-sm mb-4">Obtiene la lista de plantillas sincronizadas.</p>
              </div>

              <CodeBlock
                id="get-templates"
                code={`curl -X GET "${baseUrl}/api/v1/templates" \\
  -H "Authorization: Bearer efk_tu_api_key"`}
              />

              <div className="bg-dark-bg rounded-lg p-4 mt-4">
                <h4 className="text-white text-sm mb-2">Respuesta:</h4>
                <CodeBlock
                  id="templates-response"
                  language="json"
                  code={`{
  "templates": [
    {
      "id": "tpl_123",
      "name": "hello_world",
      "language": "es",
      "category": "UTILITY",
      "status": "APPROVED",
      "bodyText": "Hola {{1}}, gracias por contactarnos!",
      "headerType": "TEXT",
      "lastSynced": "2024-01-15T10:00:00Z"
    }
  ]
}`}
                />
              </div>

              <div className="mt-6">
                <h3 className="text-white font-medium mb-2">POST /api/v1/templates/sync</h3>
                <p className="text-gray-400 text-sm mb-4">Sincroniza plantillas desde Meta a la base de datos local.</p>
              </div>

              <CodeBlock
                id="sync-templates"
                code={`curl -X POST "${baseUrl}/api/v1/templates/sync" \\
  -H "Authorization: Bearer efk_tu_api_key"`}
              />

              <div className="mt-6">
                <h3 className="text-white font-medium mb-2">POST /api/v1/templates/send</h3>
                <p className="text-gray-400 text-sm mb-4">Envia un mensaje usando una plantilla aprobada.</p>
              </div>

              <CodeBlock
                id="send-template"
                code={`curl -X POST "${baseUrl}/api/v1/templates/send" \\
  -H "Authorization: Bearer efk_tu_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "templateName": "hello_world",
    "to": "5215512345678",
    "variables": ["Juan"],
    "headerVariables": []
  }'`}
              />

              <div className="bg-dark-bg rounded-lg p-4 mt-4">
                <h4 className="text-white text-sm mb-2">Parametros:</h4>
                <ul className="text-gray-400 text-sm space-y-1">
                  <li><code className="text-neon-blue">templateName</code> (requerido) - Nombre exacto de la plantilla</li>
                  <li><code className="text-neon-blue">to</code> (requerido) - Numero de telefono del destinatario</li>
                  <li><code className="text-neon-blue">variables</code> - Array de variables para el cuerpo (body)</li>
                  <li><code className="text-neon-blue">headerVariables</code> - Array de variables para el encabezado</li>
                </ul>
              </div>
            </>
          )}

          {activeTab === 'agente' && (
            <>
              <div>
                <h3 className="text-white font-medium mb-2">GET /api/v1/agent-config</h3>
                <p className="text-gray-400 text-sm mb-4">Obtiene la configuracion completa del agente IA (prompt, tools, etc).</p>
              </div>

              <CodeBlock
                id="get-agent-config"
                code={`curl -X GET "${baseUrl}/api/v1/agent-config" \\
  -H "Authorization: Bearer efk_tu_api_key"`}
              />

              <div className="bg-dark-bg rounded-lg p-4 mt-4">
                <h4 className="text-white text-sm mb-2">Respuesta:</h4>
                <CodeBlock
                  id="agent-config-response"
                  language="json"
                  code={`{
  "agentVersion": "v2",
  "botEnabled": true,
  "prompt": "Eres un asistente de ventas...",
  "historyLimit": 10,
  "splitMessages": true,
  "tools": [
    {
      "id": "tool_123",
      "name": "consultar_inventario",
      "description": "Verifica stock de productos",
      "endpoint": "https://mi-api.com/stock",
      "method": "POST",
      "enabled": true
    }
  ],
  "policy": {
    "shippingPolicy": "Envio gratis en compras mayores a $500",
    "refundPolicy": "30 dias para devoluciones"
  },
  "businessObjective": "SALES",
  "timezone": "America/Lima"
}`}
                />
              </div>

              <div className="mt-6">
                <h3 className="text-white font-medium mb-2">PUT /api/v1/agent-config</h3>
                <p className="text-gray-400 text-sm mb-4">Actualiza la configuracion del agente (prompt, version, etc).</p>
              </div>

              <CodeBlock
                id="update-agent-config"
                code={`curl -X PUT "${baseUrl}/api/v1/agent-config" \\
  -H "Authorization: Bearer efk_tu_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "Eres un asistente de ventas profesional...",
    "botEnabled": true,
    "agentVersion": "v2",
    "historyLimit": 15,
    "splitMessages": true
  }'`}
              />

              <div className="bg-dark-bg rounded-lg p-4 mt-4">
                <h4 className="text-white text-sm mb-2">Parametros:</h4>
                <ul className="text-gray-400 text-sm space-y-1">
                  <li><code className="text-neon-blue">prompt</code> - Texto del prompt maestro del agente</li>
                  <li><code className="text-neon-blue">botEnabled</code> - Activar/desactivar el bot (true/false)</li>
                  <li><code className="text-neon-blue">agentVersion</code> - Version del agente: "v1" o "v2"</li>
                  <li><code className="text-neon-blue">historyLimit</code> - Cantidad de mensajes de historial a considerar</li>
                  <li><code className="text-neon-blue">splitMessages</code> - Dividir mensajes largos (true/false)</li>
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

              <div className="bg-dark-bg rounded-lg p-4 mt-4">
                <h4 className="text-white text-sm mb-2">Parametros actualizables:</h4>
                <ul className="text-gray-400 text-sm space-y-1">
                  <li><code className="text-neon-blue">name</code> - Nombre del contacto</li>
                  <li><code className="text-neon-blue">email</code> - Email del contacto</li>
                  <li><code className="text-neon-blue">tags</code> - Array de etiquetas ["VIP", "Cliente"]</li>
                  <li><code className="text-neon-blue">notes</code> - Notas del contacto</li>
                  <li><code className="text-neon-blue">leadStage</code> - Etapa del lead</li>
                  <li><code className="text-neon-blue">botPaused</code> - Pausar bot para este contacto (true/false)</li>
                </ul>
              </div>
            </>
          )}

          {activeTab === 'productos' && (
            <>
              <div>
                <h3 className="text-white font-medium mb-2">GET /api/v1/products</h3>
                <p className="text-gray-400 text-sm mb-4">Obtiene la lista de productos del negocio.</p>
              </div>

              <CodeBlock
                id="get-products"
                code={`curl -X GET "${baseUrl}/api/v1/products?limit=100&inStock=true" \\
  -H "Authorization: Bearer efk_tu_api_key"`}
              />

              <div className="bg-dark-bg rounded-lg p-4 mt-4">
                <h4 className="text-white text-sm mb-2">Parametros de consulta:</h4>
                <ul className="text-gray-400 text-sm space-y-1">
                  <li><code className="text-neon-blue">limit</code> - Cantidad maxima de productos (default: 100, max: 500)</li>
                  <li><code className="text-neon-blue">inStock</code> - Solo productos con stock (true/false)</li>
                </ul>
              </div>

              <div className="bg-dark-bg rounded-lg p-4 mt-4">
                <h4 className="text-white text-sm mb-2">Respuesta:</h4>
                <CodeBlock
                  id="products-response"
                  language="json"
                  code={`{
  "products": [
    {
      "id": "prod_123",
      "title": "Producto Premium",
      "description": "Descripcion del producto",
      "price": 99.99,
      "stock": 50,
      "imageUrl": "https://..."
    }
  ]
}`}
                />
              </div>
            </>
          )}

          {activeTab === 'recordatorios' && (
            <>
              <div>
                <h3 className="text-white font-medium mb-2">GET /api/v1/reminders</h3>
                <p className="text-gray-400 text-sm mb-4">Obtiene la lista de recordatorios programados.</p>
              </div>

              <CodeBlock
                id="get-reminders"
                code={`curl -X GET "${baseUrl}/api/v1/reminders?status=pending&limit=50" \\
  -H "Authorization: Bearer efk_tu_api_key"`}
              />

              <div className="mt-6">
                <h3 className="text-white font-medium mb-2">POST /api/v1/reminders</h3>
                <p className="text-gray-400 text-sm mb-4">Crea un nuevo recordatorio para un contacto.</p>
              </div>

              <CodeBlock
                id="create-reminder"
                code={`curl -X POST "${baseUrl}/api/v1/reminders" \\
  -H "Authorization: Bearer efk_tu_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "contactPhone": "5215512345678",
    "message": "Hola! Solo queria dar seguimiento...",
    "scheduledAt": "2024-01-20T14:00:00Z",
    "type": "manual"
  }'`}
              />

              <div className="bg-dark-bg rounded-lg p-4 mt-4">
                <h4 className="text-white text-sm mb-2">Parametros:</h4>
                <ul className="text-gray-400 text-sm space-y-1">
                  <li><code className="text-neon-blue">contactPhone</code> (requerido) - Telefono del contacto</li>
                  <li><code className="text-neon-blue">scheduledAt</code> (requerido) - Fecha/hora ISO 8601</li>
                  <li><code className="text-neon-blue">message</code> - Mensaje a enviar (opcional, se genera con IA si no se provee)</li>
                  <li><code className="text-neon-blue">type</code> - Tipo: "manual" o "auto" (default: manual)</li>
                </ul>
              </div>

              <div className="mt-6">
                <h3 className="text-white font-medium mb-2">DELETE /api/v1/reminders/:id</h3>
                <p className="text-gray-400 text-sm mb-4">Elimina un recordatorio.</p>
              </div>

              <CodeBlock
                id="delete-reminder"
                code={`curl -X DELETE "${baseUrl}/api/v1/reminders/reminder_123" \\
  -H "Authorization: Bearer efk_tu_api_key"`}
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

          {activeTab === 'negocio' && (
            <>
              <div>
                <h3 className="text-white font-medium mb-2">GET /api/v1/business-info</h3>
                <p className="text-gray-400 text-sm mb-4">Obtiene informacion completa del negocio, instancias y configuracion.</p>
              </div>

              <CodeBlock
                id="get-business-info"
                code={`curl -X GET "${baseUrl}/api/v1/business-info" \\
  -H "Authorization: Bearer efk_tu_api_key"`}
              />

              <div className="bg-dark-bg rounded-lg p-4 mt-4">
                <h4 className="text-white text-sm mb-2">Respuesta:</h4>
                <CodeBlock
                  id="business-info-response"
                  language="json"
                  code={`{
  "id": "biz_123",
  "name": "Mi Negocio",
  "botEnabled": true,
  "agentVersion": "v2",
  "businessObjective": "SALES",
  "timezone": "America/Lima",
  "instances": [
    {
      "id": "inst_123",
      "name": "Ventas Principal",
      "phoneNumber": "+5215512345678",
      "provider": "META_COEXIST",
      "status": "CONNECTED",
      "isActive": true
    }
  ],
  "followUpConfigs": [
    {
      "id": "cfg_123",
      "instanceId": "inst_123",
      "enabled": true,
      "firstDelayMinutes": 15,
      "triggerMode": "user"
    }
  ]
}`}
                />
              </div>

              <div className="bg-dark-bg rounded-lg p-4 mt-4">
                <h4 className="text-white text-sm mb-2">GET /api/v1/me</h4>
                <p className="text-gray-400 text-sm">Informacion basica del negocio e instancia asociada a la API key.</p>
                <CodeBlock
                  id="get-me"
                  code={`curl -X GET "${baseUrl}/api/v1/me" \\
  -H "Authorization: Bearer efk_tu_api_key"`}
                />
              </div>
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

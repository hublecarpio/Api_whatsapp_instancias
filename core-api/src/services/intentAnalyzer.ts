import prisma from './prisma.js';
import OpenAI from 'openai';
import { getOpenAIClient, isOpenAIConfigured, getDefaultModel } from './openaiService.js';

export type IntentType = 
  | 'GREETING'
  | 'PRODUCT_INQUIRY'
  | 'PRICE_INQUIRY'
  | 'OBJECTION'
  | 'READY_TO_BUY'
  | 'SCHEDULE_APPOINTMENT'
  | 'SUPPORT_REQUEST'
  | 'COMPLAINT'
  | 'FOLLOWUP'
  | 'CLOSING'
  | 'OTHER';

export interface IntentAnalysis {
  intent: IntentType;
  confidence: number;
  objection?: {
    id: string;
    name: string;
    responseScript: string;
  };
  reasoning: string;
  suggestedTools: string[];
  urgency: 'low' | 'medium' | 'high';
}

export interface ConversationContext {
  recentIntents: IntentType[];
  currentFunnelStage?: string;
  messageCount: number;
  hasOpenOrder: boolean;
  hasPendingAppointment: boolean;
}

const INTENT_ANALYSIS_PROMPT = `Eres un analizador de intenciones de mensajes de clientes. Tu tarea es clasificar el mensaje del cliente en una de las siguientes categorías:

CATEGORÍAS DE INTENCIÓN:
- GREETING: Saludos iniciales, presentaciones
- PRODUCT_INQUIRY: Preguntas sobre productos, características, disponibilidad
- PRICE_INQUIRY: Preguntas específicas sobre precios, costos, descuentos
- OBJECTION: Objeciones de venta (muy caro, no estoy seguro, lo pienso, etc.)
- READY_TO_BUY: Cliente listo para comprar, pide cómo pagar
- SCHEDULE_APPOINTMENT: Cliente quiere agendar una cita o consulta
- SUPPORT_REQUEST: Solicitud de ayuda, soporte técnico
- COMPLAINT: Queja, problema, insatisfacción
- FOLLOWUP: Respuesta a mensaje anterior, continuación de conversación
- CLOSING: Despedida, agradecimiento final
- OTHER: No encaja en ninguna categoría

REGLAS:
1. Analiza el contexto de la conversación (mensajes anteriores)
2. Considera el tono y urgencia del mensaje
3. Identifica si hay una objeción oculta
4. Sugiere qué herramientas serían útiles para responder

Responde SOLO en formato JSON con esta estructura:
{
  "intent": "CATEGORIA",
  "confidence": 0.0-1.0,
  "reasoning": "Breve explicación",
  "suggestedTools": ["tool1", "tool2"],
  "urgency": "low|medium|high",
  "possibleObjection": "Si detectas objeción, describe cuál"
}`;

export async function analyzeIntent(
  businessId: string,
  message: string,
  conversationHistory: string[],
  businessObjective: 'SALES' | 'APPOINTMENTS',
  contactPhone?: string
): Promise<IntentAnalysis> {
  const objections = await prisma.salesObjection.findMany({
    where: { businessId, isActive: true },
    orderBy: { priority: 'desc' }
  });

  const matchedObjection = await matchObjectionByKeywords(message, objections);
  if (matchedObjection) {
    return {
      intent: 'OBJECTION',
      confidence: 0.95,
      objection: {
        id: matchedObjection.id,
        name: matchedObjection.name,
        responseScript: matchedObjection.responseScript
      },
      reasoning: `Matched objection keyword: ${matchedObjection.name}`,
      suggestedTools: [],
      urgency: 'high'
    };
  }

  if (!isOpenAIConfigured()) {
    return getDefaultIntentWithContext(message, businessObjective);
  }

  try {
    const openai = getOpenAIClient();
    const model = getDefaultModel();
    
    const historyContext = conversationHistory.slice(-5).join('\n');
    
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: INTENT_ANALYSIS_PROMPT },
        { 
          role: 'user', 
          content: `Contexto del negocio: ${businessObjective === 'SALES' ? 'Ventas de productos' : 'Agendamiento de citas'}

Historial reciente:
${historyContext}

Mensaje actual del cliente:
"${message}"

Objeciones configuradas del negocio:
${objections.map((o: { name: string; triggerPhrases: string[] }) => `- ${o.name}: ${o.triggerPhrases.join(', ')}`).join('\n')}

Analiza la intención:`
        }
      ],
      max_tokens: 300,
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(completion.choices[0]?.message?.content || '{}');
    
    let objectionData;
    if (result.intent === 'OBJECTION' && result.possibleObjection) {
      const matchedByAI = objections.find((o: { id: string; name: string; responseScript: string }) => 
        o.name.toLowerCase().includes(result.possibleObjection.toLowerCase()) ||
        result.possibleObjection.toLowerCase().includes(o.name.toLowerCase())
      );
      if (matchedByAI) {
        objectionData = {
          id: matchedByAI.id,
          name: matchedByAI.name,
          responseScript: matchedByAI.responseScript
        };
      }
    }

    await prisma.intentLog.create({
      data: {
        businessId,
        contactPhone: contactPhone || '',
        detectedIntent: result.intent || 'OTHER',
        confidence: result.confidence || 0.5,
        objectionId: objectionData?.id,
        reasoning: result.reasoning
      }
    });

    return {
      intent: result.intent || 'OTHER',
      confidence: result.confidence || 0.5,
      objection: objectionData,
      reasoning: result.reasoning || '',
      suggestedTools: result.suggestedTools || [],
      urgency: result.urgency || 'medium'
    };
  } catch (error) {
    console.error('[IntentAnalyzer] Error:', error);
    return getDefaultIntent();
  }
}

async function matchObjectionByKeywords(
  message: string,
  objections: Array<{ id: string; name: string; triggerPhrases: string[]; responseScript: string }>
): Promise<{ id: string; name: string; triggerPhrases: string[]; responseScript: string } | null> {
  const lowerMessage = message.toLowerCase();
  
  for (const objection of objections) {
    for (const phrase of objection.triggerPhrases) {
      if (lowerMessage.includes(phrase.toLowerCase())) {
        return objection;
      }
    }
  }
  
  return null;
}

function getDefaultIntent(): IntentAnalysis {
  return {
    intent: 'OTHER',
    confidence: 0.5,
    reasoning: 'Default fallback - no analysis available',
    suggestedTools: [],
    urgency: 'medium'
  };
}

function getDefaultIntentWithContext(
  message: string,
  businessObjective: 'SALES' | 'APPOINTMENTS'
): IntentAnalysis {
  const lowerMessage = message.toLowerCase();
  
  const greetingKeywords = ['hola', 'buenos días', 'buenas tardes', 'buenas noches', 'hey', 'hi'];
  if (greetingKeywords.some(kw => lowerMessage.includes(kw))) {
    return {
      intent: 'GREETING',
      confidence: 0.7,
      reasoning: 'Keyword-based greeting detection',
      suggestedTools: [],
      urgency: 'low'
    };
  }
  
  const priceKeywords = ['precio', 'costo', 'cuánto', 'cuanto', 'vale', 'cuesta'];
  if (priceKeywords.some(kw => lowerMessage.includes(kw))) {
    return {
      intent: 'PRICE_INQUIRY',
      confidence: 0.7,
      reasoning: 'Keyword-based price inquiry detection',
      suggestedTools: ['buscar_producto'],
      urgency: 'medium'
    };
  }
  
  const appointmentKeywords = ['cita', 'agendar', 'disponibilidad', 'horario', 'reservar'];
  if (appointmentKeywords.some(kw => lowerMessage.includes(kw))) {
    return {
      intent: 'SCHEDULE_APPOINTMENT',
      confidence: 0.7,
      reasoning: 'Keyword-based appointment detection',
      suggestedTools: ['ver_disponibilidad', 'agendar_cita'],
      urgency: 'medium'
    };
  }
  
  const buyKeywords = ['comprar', 'pagar', 'ordenar', 'pedido', 'quiero'];
  if (buyKeywords.some(kw => lowerMessage.includes(kw))) {
    return {
      intent: businessObjective === 'APPOINTMENTS' ? 'SCHEDULE_APPOINTMENT' : 'READY_TO_BUY',
      confidence: 0.6,
      reasoning: 'Keyword-based purchase intent detection',
      suggestedTools: businessObjective === 'APPOINTMENTS' ? ['agendar_cita'] : ['crear_enlace_pago'],
      urgency: 'high'
    };
  }
  
  // Payment method confirmation keywords - indicates customer is confirming how they will pay
  const paymentConfirmationKeywords = [
    'al contado', 'contado', 'efectivo', 'transferencia', 'yape', 'plin',
    'confirmo', 'confirmado', 'acepto', 'listo', 'va', 'dale', 'si quiero',
    'lo llevo', 'me lo llevo', 'deposito', 'depósito', 'lo tomo', 'me interesa',
    'enviame', 'envíame', 'mandame', 'mándame', 'procede', 'adelante'
  ];
  if (paymentConfirmationKeywords.some(kw => lowerMessage.includes(kw)) && businessObjective !== 'APPOINTMENTS') {
    return {
      intent: 'READY_TO_BUY',
      confidence: 0.7,
      reasoning: 'Payment method confirmation detected - customer confirming purchase',
      suggestedTools: ['registrar_pedido', 'crear_enlace_pago'],
      urgency: 'high'
    };
  }
  
  return {
    intent: 'OTHER',
    confidence: 0.5,
    reasoning: 'No keyword match, using default',
    suggestedTools: [],
    urgency: 'medium'
  };
}

export function selectToolsForIntent(
  intent: IntentType,
  businessObjective: 'SALES' | 'APPOINTMENTS',
  availableTools: string[]
): string[] {
  const toolPriority: Record<IntentType, string[]> = {
    'GREETING': [],
    'PRODUCT_INQUIRY': ['buscar_producto'],
    'PRICE_INQUIRY': ['buscar_producto'],
    'OBJECTION': [],
    'READY_TO_BUY': ['registrar_pedido', 'buscar_producto'],
    'SCHEDULE_APPOINTMENT': ['consultar_disponibilidad', 'agendar_cita'],
    'SUPPORT_REQUEST': ['enviar_archivo'],
    'COMPLAINT': [],
    'FOLLOWUP': ['buscar_producto'],
    'CLOSING': [],
    'OTHER': []
  };

  const prioritized = toolPriority[intent] || [];
  
  if (businessObjective === 'APPOINTMENTS') {
    return prioritized.filter(t => 
      ['consultar_disponibilidad', 'agendar_cita', 'enviar_archivo'].includes(t) ||
      availableTools.includes(t)
    );
  }
  
  return prioritized.filter(t => availableTools.includes(t) || 
    ['buscar_producto', 'crear_enlace_pago', 'registrar_pedido', 'enviar_archivo'].includes(t));
}

export interface DynamicPromptOptions {
  paymentLinkEnabled?: boolean;
  extractedData?: Record<string, any>;
}

export function buildDynamicPrompt(
  basePrompt: string,
  intent: IntentAnalysis,
  conversationContext: ConversationContext,
  businessObjective: 'SALES' | 'APPOINTMENTS',
  options: DynamicPromptOptions = {}
): string {
  let dynamicPrompt = basePrompt;
  const { paymentLinkEnabled = false, extractedData } = options;
  
  dynamicPrompt += `\n\n## REGLAS DE COMUNICACIÓN EFICIENTE:`;
  dynamicPrompt += `\n- NO repitas información que ya confirmaste en mensajes anteriores`;
  dynamicPrompt += `\n- NO hagas preguntas cuyas respuestas ya tienes en el contexto`;
  dynamicPrompt += `\n- Sé conciso y avanza hacia la acción/cierre`;
  dynamicPrompt += `\n- Si ya tienes nombre, dirección y producto, procede directamente`;
  
  if (extractedData && Object.keys(extractedData).length > 0) {
    dynamicPrompt += `\n\n## DATOS YA EXTRAÍDOS DEL CLIENTE (NO volver a preguntar):`;
    for (const [key, value] of Object.entries(extractedData)) {
      if (value) {
        dynamicPrompt += `\n- ${key}: ${value}`;
      }
    }
  }
  
  dynamicPrompt += `\n\n## CONTEXTO ACTUAL DE ESTA CONVERSACIÓN:`;
  dynamicPrompt += `\n- Intención detectada: ${intent.intent} (confianza: ${(intent.confidence * 100).toFixed(0)}%)`;
  dynamicPrompt += `\n- Urgencia: ${intent.urgency}`;
  dynamicPrompt += `\n- Mensajes intercambiados: ${conversationContext.messageCount}`;
  
  if (conversationContext.currentFunnelStage) {
    dynamicPrompt += `\n- Etapa del funnel: ${conversationContext.currentFunnelStage}`;
  }

  if (intent.objection) {
    dynamicPrompt += `\n\n## OBJECIÓN DETECTADA - RESPONDER CON CUIDADO:`;
    dynamicPrompt += `\nObjeción: "${intent.objection.name}"`;
    dynamicPrompt += `\n\nScript de respuesta sugerido:\n${intent.objection.responseScript}`;
    dynamicPrompt += `\n\nIMPORTANTE: Adapta el script al contexto de la conversación. No lo copies textualmente.`;
  }

  switch (intent.intent) {
    case 'GREETING':
      dynamicPrompt += `\n\n## INSTRUCCIÓN PARA SALUDO:`;
      dynamicPrompt += `\n- Responde de forma cálida y profesional`;
      dynamicPrompt += `\n- Pregunta cómo puedes ayudar`;
      dynamicPrompt += `\n- NO ofrezcas productos inmediatamente`;
      break;
      
    case 'PRODUCT_INQUIRY':
    case 'PRICE_INQUIRY':
      dynamicPrompt += `\n\n## INSTRUCCIÓN PARA CONSULTA:`;
      dynamicPrompt += `\n- Usa la herramienta buscar_producto si es necesario`;
      dynamicPrompt += `\n- Proporciona información clara y precisa`;
      dynamicPrompt += `\n- Incluye precio y disponibilidad`;
      dynamicPrompt += `\n- Sugiere productos relacionados si aplica`;
      break;
      
    case 'READY_TO_BUY':
      dynamicPrompt += `\n\n## CLIENTE LISTO PARA COMPRAR:`;
      dynamicPrompt += `\n- Confirma los detalles del pedido (solo si no los has confirmado antes)`;
      dynamicPrompt += `\n- Solicita datos de envío SOLO si no los tienes`;
      if (paymentLinkEnabled) {
        dynamicPrompt += `\n- USA la herramienta crear_enlace_pago para generar el link de pago`;
        dynamicPrompt += `\n- Una vez generado, comparte el enlace con el cliente`;
      } else {
        dynamicPrompt += `\n- USA la herramienta registrar_pedido para crear el pedido`;
        dynamicPrompt += `\n- Indica los datos bancarios para transferencia (si los tienes en tu contexto)`;
        dynamicPrompt += `\n- Pide al cliente que envíe el comprobante/voucher una vez realizada la transferencia`;
        dynamicPrompt += `\n- NO menciones "enlace de pago" - el cliente debe hacer transferencia manual`;
      }
      dynamicPrompt += `\n- Muestra entusiasmo pero sin exagerar`;
      dynamicPrompt += `\n- NO vuelvas a preguntar cosas que ya confirmaste`;
      break;
      
    case 'SCHEDULE_APPOINTMENT':
      dynamicPrompt += `\n\n## CLIENTE QUIERE AGENDAR:`;
      dynamicPrompt += `\n- Usa consultar_disponibilidad para verificar horarios`;
      dynamicPrompt += `\n- Ofrece opciones de fecha/hora`;
      dynamicPrompt += `\n- Confirma todos los detalles antes de agendar`;
      break;
      
    case 'OBJECTION':
      dynamicPrompt += `\n\n## MANEJO DE OBJECIÓN:`;
      dynamicPrompt += `\n- Escucha y valida la preocupación del cliente`;
      dynamicPrompt += `\n- No seas insistente ni presiones`;
      dynamicPrompt += `\n- Ofrece información adicional que pueda ayudar`;
      dynamicPrompt += `\n- Deja la puerta abierta para continuar después`;
      break;
      
    case 'COMPLAINT':
      dynamicPrompt += `\n\n## MANEJO DE QUEJA:`;
      dynamicPrompt += `\n- Muestra empatía genuina`;
      dynamicPrompt += `\n- Ofrece disculpas si es apropiado`;
      dynamicPrompt += `\n- Proporciona una solución o siguiente paso`;
      dynamicPrompt += `\n- Escala si es necesario`;
      break;
      
    case 'CLOSING':
      dynamicPrompt += `\n\n## DESPEDIDA:`;
      dynamicPrompt += `\n- Agradece la conversación`;
      dynamicPrompt += `\n- Ofrece ayuda futura`;
      dynamicPrompt += `\n- Mantén el tono profesional`;
      break;
  }

  if (intent.suggestedTools.length > 0) {
    dynamicPrompt += `\n\n## HERRAMIENTAS SUGERIDAS:`;
    dynamicPrompt += `\nConsidera usar: ${intent.suggestedTools.join(', ')}`;
  }

  return dynamicPrompt;
}

export async function getConversationContext(
  businessId: string,
  contactPhone: string
): Promise<ConversationContext> {
  const [recentIntents, funnelState, messageCount, openOrder, pendingAppointment] = await Promise.all([
    prisma.intentLog.findMany({
      where: { businessId, contactPhone },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { detectedIntent: true }
    }),
    prisma.contactFunnelState.findUnique({
      where: { businessId_contactPhone: { businessId, contactPhone } },
      include: { stage: { select: { name: true } } }
    }),
    prisma.messageLog.count({
      where: {
        businessId,
        OR: [
          { sender: contactPhone },
          { recipient: contactPhone }
        ]
      }
    }),
    prisma.order.findFirst({
      where: {
        businessId,
        contactPhone: contactPhone.replace(/\D/g, ''),
        status: { in: ['PENDING_PAYMENT', 'AWAITING_VOUCHER'] }
      }
    }),
    prisma.appointment.findFirst({
      where: {
        businessId,
        contactPhone,
        status: 'CONFIRMED',
        scheduledAt: { gte: new Date() }
      }
    })
  ]);

  return {
    recentIntents: recentIntents.map((i: { detectedIntent: string }) => i.detectedIntent as IntentType),
    currentFunnelStage: funnelState?.stage?.name,
    messageCount,
    hasOpenOrder: !!openOrder,
    hasPendingAppointment: !!pendingAppointment
  };
}

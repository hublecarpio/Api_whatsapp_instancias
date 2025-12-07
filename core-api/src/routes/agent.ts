import { Router, Request, Response } from 'express';
import OpenAI from 'openai';
import axios from 'axios';
import prisma from '../services/prisma.js';

const router = Router();
const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';

const activeBuffers = new Map<string, NodeJS.Timeout>();

function interpolateString(template: string, args: Record<string, any>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = args[key];
    return value !== undefined ? String(value) : '';
  });
}

function interpolateValue(value: any, args: Record<string, any>): any {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
      const key = trimmed.slice(2, -2);
      return args[key] !== undefined ? args[key] : value;
    }
    return interpolateString(value, args);
  }
  if (Array.isArray(value)) {
    return value.map(item => interpolateValue(item, args));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateValue(v, args);
    }
    return result;
  }
  return value;
}

async function executeExternalTool(tool: any, args: any): Promise<string> {
  try {
    const url = interpolateString(tool.url, args);
    
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tool.headers) {
      const rawHeaders = tool.headers as Record<string, string>;
      for (const [key, value] of Object.entries(rawHeaders)) {
        headers[key] = interpolateString(String(value), args);
      }
    }
    
    let body = args;
    if (tool.bodyTemplate) {
      body = interpolateValue(tool.bodyTemplate, args);
    }
    
    const fetchOptions: RequestInit = {
      method: tool.method || 'POST',
      headers
    };
    
    if (tool.method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }
    
    const response = await fetch(url, fetchOptions);
    
    const data = await response.text();
    try {
      return JSON.stringify(JSON.parse(data));
    } catch {
      return data;
    }
  } catch (error: any) {
    return JSON.stringify({ error: error.message });
  }
}

async function sendMessageInParts(
  instanceBackendId: string,
  to: string,
  message: string,
  splitMessages: boolean
): Promise<void> {
  if (!splitMessages) {
    await axios.post(`${WA_API_URL}/instances/${instanceBackendId}/sendMessage`, {
      to,
      message
    });
    return;
  }
  
  const parts = message.split(/\n{2,}/).filter(p => p.trim());
  
  if (parts.length <= 1) {
    await axios.post(`${WA_API_URL}/instances/${instanceBackendId}/sendMessage`, {
      to,
      message
    });
    return;
  }
  
  for (let i = 0; i < parts.length; i++) {
    await axios.post(`${WA_API_URL}/instances/${instanceBackendId}/sendMessage`, {
      to,
      message: parts[i].trim()
    });
    
    if (i < parts.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 400));
    }
  }
}

async function processWithAgent(
  businessId: string,
  messages: string[],
  phone: string,
  contactPhone: string,
  contactName: string,
  instanceId?: string
): Promise<{ response: string; tokensUsed?: number }> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      policy: true,
      promptMaster: { include: { tools: { where: { enabled: true } } } },
      products: true,
      instances: true
    }
  });
  
  if (!business) {
    throw new Error('Business not found');
  }
  
  if (!business.botEnabled) {
    return { response: '' };
  }
  
  if (!business.openaiApiKey) {
    throw new Error('OpenAI API key not configured');
  }
  
  const openai = new OpenAI({ apiKey: business.openaiApiKey });
  const promptConfig = business.promptMaster;
  const historyLimit = promptConfig?.historyLimit || 10;
  const splitMessages = promptConfig?.splitMessages ?? true;
  const tools = promptConfig?.tools || [];
  
  let systemPrompt = promptConfig?.prompt || 'Eres un asistente de atención al cliente amable y profesional.';
  
  if (business.policy) {
    systemPrompt += `\n\n## Políticas del negocio:`;
    if (business.policy.shippingPolicy) {
      systemPrompt += `\n- Envíos: ${business.policy.shippingPolicy}`;
    }
    if (business.policy.refundPolicy) {
      systemPrompt += `\n- Devoluciones: ${business.policy.refundPolicy}`;
    }
    if (business.policy.brandVoice) {
      systemPrompt += `\n- Tono de marca: ${business.policy.brandVoice}`;
    }
  }
  
  if (business.products && business.products.length > 0) {
    systemPrompt += `\n\n## Catálogo de productos:`;
    business.products.forEach(product => {
      systemPrompt += `\n- ${product.title}: $${product.price}`;
      if (product.description) {
        systemPrompt += ` - ${product.description}`;
      }
    });
  }
  
  const recentMessages = await prisma.messageLog.findMany({
    where: { 
      businessId,
      OR: [
        { sender: contactPhone },
        { recipient: contactPhone },
        { sender: phone },
        { recipient: phone }
      ]
    },
    orderBy: { createdAt: 'desc' },
    take: historyLimit
  });
  
  const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = 
    recentMessages.reverse().map(msg => ({
      role: msg.direction === 'inbound' ? 'user' : 'assistant' as const,
      content: msg.message || ''
    }));
  
  const combinedUserMessage = messages.join('\n');
  conversationHistory.push({ role: 'user', content: combinedUserMessage });
  
  const openaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map(tool => {
    const toolParams = (tool.parameters as any[]) || [];
    const properties: Record<string, any> = {};
    const required: string[] = [];
    
    if (toolParams.length > 0) {
      toolParams.forEach((param: any) => {
        properties[param.name] = {
          type: param.type || 'string',
          description: param.description || `Parameter ${param.name}`
        };
        if (param.required) {
          required.push(param.name);
        }
      });
    } else {
      properties['query'] = { type: 'string', description: 'The query or data to send to the external service' };
      required.push('query');
    }
    
    return {
      type: 'function' as const,
      function: {
        name: tool.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
        description: tool.description,
        parameters: {
          type: 'object',
          properties,
          required
        }
      }
    };
  });
  
  const chatParams: any = {
    model: business.openaiModel || 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      ...conversationHistory
    ],
    max_tokens: 800,
    temperature: 0.7
  };
  
  if (openaiTools.length > 0) {
    chatParams.tools = openaiTools;
    chatParams.tool_choice = 'auto';
  }
  
  let completion = await openai.chat.completions.create(chatParams);
  let totalTokens = completion.usage?.total_tokens || 0;
  
  while (completion.choices[0]?.message?.tool_calls) {
    const toolCalls = completion.choices[0].message.tool_calls;
    const toolMessages: any[] = [completion.choices[0].message];
    
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      const tool = tools.find(t => t.name.replace(/[^a-zA-Z0-9_-]/g, '_') === toolName);
      
      if (tool) {
        const args = JSON.parse(toolCall.function.arguments);
        const result = await executeExternalTool(tool, args);
        
        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result
        });
      }
    }
    
    const nextParams: any = {
      model: business.openaiModel || 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
        ...toolMessages
      ],
      max_tokens: 800,
      temperature: 0.7
    };
    
    if (openaiTools.length > 0) {
      nextParams.tools = openaiTools;
    }
    
    completion = await openai.chat.completions.create(nextParams);
    totalTokens += completion.usage?.total_tokens || 0;
  }
  
  const aiResponse = completion.choices[0]?.message?.content || 'Lo siento, no pude procesar tu mensaje.';
  
  const instance = business.instances[0];
  if (instance) {
    try {
      await sendMessageInParts(instance.instanceBackendId, phone, aiResponse, splitMessages);
      
      await prisma.messageLog.create({
        data: {
          businessId,
          instanceId: instance.id,
          direction: 'outbound',
          recipient: contactPhone,
          message: aiResponse,
          metadata: {
            contactJid: phone,
            contactPhone,
            contactName: contactName || '',
            splitMessages
          }
        }
      });
    } catch (sendError: any) {
      console.error('Failed to send WhatsApp message:', sendError.response?.data || sendError.message);
    }
  }
  
  return { response: aiResponse, tokensUsed: totalTokens };
}

router.post('/think', async (req: Request, res: Response) => {
  try {
    const { business_id, user_message, phone, phoneNumber, contactName, instanceId } = req.body;
    
    if (!business_id || !user_message || !phone) {
      return res.status(400).json({ error: 'business_id, user_message and phone are required' });
    }
    
    const contactPhone = phoneNumber || phone.replace('@s.whatsapp.net', '').replace('@lid', '');
    
    const business = await prisma.business.findUnique({
      where: { id: business_id },
      include: { promptMaster: true }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (!business.botEnabled) {
      return res.json({
        action: 'manual',
        message: 'Bot is disabled',
        botEnabled: false
      });
    }
    
    const bufferSeconds = business.promptMaster?.bufferSeconds || 0;
    const bufferKey = `${business_id}:${contactPhone}`;
    
    if (bufferSeconds > 0) {
      const existingTimeout = activeBuffers.get(bufferKey);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }
      
      const existingBuffer = await prisma.messageBuffer.findUnique({
        where: { businessId_contactPhone: { businessId: business_id, contactPhone } }
      });
      
      const currentMessages = existingBuffer 
        ? [...(existingBuffer.messages as string[]), user_message]
        : [user_message];
      
      await prisma.messageBuffer.upsert({
        where: { businessId_contactPhone: { businessId: business_id, contactPhone } },
        create: {
          businessId: business_id,
          contactPhone,
          messages: currentMessages,
          expiresAt: new Date(Date.now() + bufferSeconds * 1000)
        },
        update: {
          messages: currentMessages,
          expiresAt: new Date(Date.now() + bufferSeconds * 1000)
        }
      });
      
      const timeout = setTimeout(async () => {
        try {
          const buffer = await prisma.messageBuffer.findUnique({
            where: { businessId_contactPhone: { businessId: business_id, contactPhone } }
          });
          
          if (buffer) {
            const messages = buffer.messages as string[];
            
            await prisma.messageBuffer.delete({
              where: { id: buffer.id }
            });
            
            activeBuffers.delete(bufferKey);
            
            await processWithAgent(
              business_id,
              messages,
              phone,
              contactPhone,
              contactName,
              instanceId
            );
          }
        } catch (error) {
          console.error('Buffer processing error:', error);
        }
      }, bufferSeconds * 1000);
      
      activeBuffers.set(bufferKey, timeout);
      
      return res.json({
        action: 'buffered',
        message: `Message buffered, will process in ${bufferSeconds} seconds`,
        bufferSeconds,
        messagesInBuffer: currentMessages.length
      });
    }
    
    const result = await processWithAgent(
      business_id,
      [user_message],
      phone,
      contactPhone,
      contactName,
      instanceId
    );
    
    res.json({
      action: 'responded',
      response: result.response,
      botEnabled: true,
      model: business.openaiModel,
      tokensUsed: result.tokensUsed
    });
  } catch (error: any) {
    console.error('Agent think error:', error);
    
    if (error.code === 'invalid_api_key') {
      return res.status(400).json({ error: 'Invalid OpenAI API key' });
    }
    
    res.status(500).json({ error: 'AI processing failed' });
  }
});

router.get('/config', async (req: Request, res: Response) => {
  try {
    const { business_id } = req.query;
    
    if (!business_id) {
      return res.status(400).json({ error: 'business_id is required' });
    }
    
    const prompt = await prisma.agentPrompt.findUnique({
      where: { businessId: business_id as string },
      include: { tools: true }
    });
    
    res.json({
      prompt: prompt?.prompt || '',
      bufferSeconds: prompt?.bufferSeconds || 0,
      historyLimit: prompt?.historyLimit || 10,
      splitMessages: prompt?.splitMessages ?? true,
      tools: prompt?.tools || []
    });
  } catch (error) {
    console.error('Get config error:', error);
    res.status(500).json({ error: 'Failed to get config' });
  }
});

export default router;

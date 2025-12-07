import { Router, Request, Response } from 'express';
import OpenAI from 'openai';
import axios from 'axios';
import prisma from '../services/prisma.js';

const router = Router();
const WA_API_URL = process.env.WA_API_URL || 'http://localhost:5000';

router.post('/think', async (req: Request, res: Response) => {
  try {
    const { business_id, user_message, phone, instanceId } = req.body;
    
    if (!business_id || !user_message || !phone) {
      return res.status(400).json({ error: 'business_id, user_message and phone are required' });
    }
    
    const business = await prisma.business.findUnique({
      where: { id: business_id },
      include: {
        policy: true,
        promptMaster: true,
        products: true,
        instances: true
      }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    await prisma.messageLog.create({
      data: {
        businessId: business_id,
        instanceId: instanceId || null,
        direction: 'inbound',
        sender: phone,
        message: user_message
      }
    });
    
    if (!business.botEnabled) {
      return res.json({
        action: 'manual',
        message: 'Bot is disabled, message logged for manual response',
        botEnabled: false
      });
    }
    
    if (!business.openaiApiKey) {
      return res.status(400).json({ error: 'OpenAI API key not configured for this business' });
    }
    
    const openai = new OpenAI({ apiKey: business.openaiApiKey });
    
    let systemPrompt = business.promptMaster?.prompt || 'Eres un asistente de atención al cliente amable y profesional.';
    
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
      where: { businessId: business_id, sender: phone },
      orderBy: { createdAt: 'desc' },
      take: 10
    });
    
    const conversationHistory = recentMessages.reverse().map(msg => ({
      role: msg.direction === 'inbound' ? 'user' : 'assistant' as const,
      content: msg.message || ''
    }));
    
    conversationHistory.push({ role: 'user', content: user_message });
    
    const completion = await openai.chat.completions.create({
      model: business.openaiModel || 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...conversationHistory
      ],
      max_tokens: 500,
      temperature: 0.7
    });
    
    const aiResponse = completion.choices[0]?.message?.content || 'Lo siento, no pude procesar tu mensaje.';
    
    const instance = business.instances[0];
    if (instance) {
      try {
        await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/sendMessage`, {
          to: phone,
          message: aiResponse
        });
        
        await prisma.messageLog.create({
          data: {
            businessId: business_id,
            instanceId: instance.id,
            direction: 'outbound',
            recipient: phone,
            message: aiResponse
          }
        });
      } catch (sendError: any) {
        console.error('Failed to send WhatsApp message:', sendError.response?.data || sendError.message);
      }
    }
    
    res.json({
      action: 'responded',
      response: aiResponse,
      botEnabled: true,
      model: business.openaiModel,
      tokensUsed: completion.usage?.total_tokens
    });
  } catch (error: any) {
    console.error('Agent think error:', error);
    
    if (error.code === 'invalid_api_key') {
      return res.status(400).json({ error: 'Invalid OpenAI API key' });
    }
    
    res.status(500).json({ error: 'AI processing failed' });
  }
});

export default router;

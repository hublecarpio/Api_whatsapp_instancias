import { Router, Response } from 'express';
import axios from 'axios';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/billing.js';

const router = Router();
const META_API_URL = 'https://graph.facebook.com/v18.0';

router.use(authMiddleware);
router.use(requireActiveSubscription);

async function getMetaCredentialForBusiness(userId: string, businessId: string) {
  const business = await prisma.business.findFirst({
    where: { id: businessId, userId }
  });
  
  if (!business) return null;
  
  const instance = await prisma.whatsAppInstance.findFirst({
    where: { businessId, provider: 'META_CLOUD' },
    include: { metaCredential: true }
  });
  
  return instance?.metaCredential || null;
}

router.get('/:businessId', async (req: AuthRequest, res: Response) => {
  try {
    const credential = await getMetaCredentialForBusiness(req.userId!, req.params.businessId);
    
    if (!credential) {
      return res.status(404).json({ 
        error: 'No Meta Cloud instance found. Please connect Meta Cloud API first.' 
      });
    }
    
    const templates = await prisma.metaTemplate.findMany({
      where: { credentialId: credential.id },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json(templates);
  } catch (error) {
    console.error('Get templates error:', error);
    res.status(500).json({ error: 'Failed to get templates' });
  }
});

router.post('/:businessId/sync', async (req: AuthRequest, res: Response) => {
  try {
    const credential = await getMetaCredentialForBusiness(req.userId!, req.params.businessId);
    
    if (!credential) {
      return res.status(404).json({ 
        error: 'No Meta Cloud instance found' 
      });
    }
    
    const response = await axios.get(
      `${META_API_URL}/${credential.businessId}/message_templates`,
      {
        headers: { Authorization: `Bearer ${credential.accessToken}` },
        params: { limit: 100 }
      }
    );
    
    const metaTemplates = response.data.data || [];
    const synced = [];
    
    for (const mt of metaTemplates) {
      const headerComponent = mt.components?.find((c: any) => c.type === 'HEADER');
      const bodyComponent = mt.components?.find((c: any) => c.type === 'BODY');
      const footerComponent = mt.components?.find((c: any) => c.type === 'FOOTER');
      const buttonsComponent = mt.components?.find((c: any) => c.type === 'BUTTONS');
      
      const template = await prisma.metaTemplate.upsert({
        where: {
          credentialId_name: {
            credentialId: credential.id,
            name: mt.name
          }
        },
        update: {
          metaTemplateId: mt.id,
          language: mt.language || 'es',
          category: mt.category || 'UTILITY',
          status: mt.status || 'PENDING',
          components: mt.components || [],
          headerType: headerComponent?.format || null,
          bodyText: bodyComponent?.text || null,
          footerText: footerComponent?.text || null,
          buttons: buttonsComponent?.buttons || null,
          lastSynced: new Date()
        },
        create: {
          credentialId: credential.id,
          metaTemplateId: mt.id,
          name: mt.name,
          language: mt.language || 'es',
          category: mt.category || 'UTILITY',
          status: mt.status || 'PENDING',
          components: mt.components || [],
          headerType: headerComponent?.format || null,
          bodyText: bodyComponent?.text || null,
          footerText: footerComponent?.text || null,
          buttons: buttonsComponent?.buttons || null
        }
      });
      
      synced.push(template);
    }
    
    res.json({ 
      synced: synced.length, 
      templates: synced,
      message: `Synchronized ${synced.length} templates from Meta`
    });
  } catch (error: any) {
    console.error('Sync templates error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to sync templates from Meta',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

router.post('/:businessId/create', async (req: AuthRequest, res: Response) => {
  try {
    const { name, language, category, headerType, headerText, headerMediaUrl, bodyText, footerText, buttons } = req.body;
    
    if (!name || !bodyText) {
      return res.status(400).json({ error: 'name and bodyText are required' });
    }
    
    const credential = await getMetaCredentialForBusiness(req.userId!, req.params.businessId);
    
    if (!credential) {
      return res.status(404).json({ error: 'No Meta Cloud instance found' });
    }
    
    const components: any[] = [];
    
    if (headerType && headerType !== 'NONE') {
      const headerComponent: any = { type: 'HEADER', format: headerType };
      if (headerType === 'TEXT' && headerText) {
        headerComponent.text = headerText;
      } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType) && headerMediaUrl) {
        headerComponent.example = { header_handle: [headerMediaUrl] };
      }
      components.push(headerComponent);
    }
    
    const bodyVariables = bodyText.match(/\{\{(\d+)\}\}/g) || [];
    const bodyComponent: any = { type: 'BODY', text: bodyText };
    if (bodyVariables.length > 0) {
      bodyComponent.example = {
        body_text: [bodyVariables.map((_: any, i: number) => `example${i + 1}`)]
      };
    }
    components.push(bodyComponent);
    
    if (footerText) {
      components.push({ type: 'FOOTER', text: footerText });
    }
    
    if (buttons && buttons.length > 0) {
      components.push({
        type: 'BUTTONS',
        buttons: buttons.map((btn: any) => ({
          type: btn.type || 'QUICK_REPLY',
          text: btn.text,
          ...(btn.url && { url: btn.url }),
          ...(btn.phone_number && { phone_number: btn.phone_number })
        }))
      });
    }
    
    const response = await axios.post(
      `${META_API_URL}/${credential.businessId}/message_templates`,
      {
        name: name.toLowerCase().replace(/\s+/g, '_'),
        language: language || 'es',
        category: category || 'UTILITY',
        components
      },
      {
        headers: { 
          Authorization: `Bearer ${credential.accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const template = await prisma.metaTemplate.create({
      data: {
        credentialId: credential.id,
        metaTemplateId: response.data.id,
        name: name.toLowerCase().replace(/\s+/g, '_'),
        language: language || 'es',
        category: category || 'UTILITY',
        status: 'PENDING',
        components,
        headerType: headerType || null,
        bodyText,
        footerText: footerText || null,
        buttons: buttons || null
      }
    });
    
    res.status(201).json({
      template,
      message: 'Template created and submitted for approval'
    });
  } catch (error: any) {
    console.error('Create template error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to create template',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

router.delete('/:businessId/:templateId', async (req: AuthRequest, res: Response) => {
  try {
    const credential = await getMetaCredentialForBusiness(req.userId!, req.params.businessId);
    
    if (!credential) {
      return res.status(404).json({ error: 'No Meta Cloud instance found' });
    }
    
    const template = await prisma.metaTemplate.findFirst({
      where: { 
        id: req.params.templateId,
        credentialId: credential.id
      }
    });
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    try {
      await axios.delete(
        `${META_API_URL}/${credential.businessId}/message_templates`,
        {
          headers: { Authorization: `Bearer ${credential.accessToken}` },
          params: { name: template.name }
        }
      );
    } catch (metaError: any) {
      console.log('Meta delete may have failed:', metaError.response?.data);
    }
    
    await prisma.metaTemplate.delete({
      where: { id: template.id }
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete template error:', error);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

router.post('/:businessId/send-template', async (req: AuthRequest, res: Response) => {
  try {
    const { templateName, to, variables, headerVariables } = req.body;
    
    if (!templateName || !to) {
      return res.status(400).json({ error: 'templateName and to are required' });
    }
    
    const credential = await getMetaCredentialForBusiness(req.userId!, req.params.businessId);
    
    if (!credential) {
      return res.status(404).json({ error: 'No Meta Cloud instance found' });
    }
    
    const template = await prisma.metaTemplate.findFirst({
      where: {
        credentialId: credential.id,
        name: templateName,
        status: 'APPROVED'
      }
    });
    
    if (!template) {
      return res.status(404).json({ error: 'Approved template not found' });
    }
    
    const cleanTo = to.replace(/\D/g, '');
    
    const templateComponents: any[] = [];
    
    if (headerVariables && headerVariables.length > 0) {
      templateComponents.push({
        type: 'header',
        parameters: headerVariables.map((v: string) => ({
          type: 'text',
          text: v
        }))
      });
    }
    
    if (variables && variables.length > 0) {
      templateComponents.push({
        type: 'body',
        parameters: variables.map((v: string) => ({
          type: 'text',
          text: v
        }))
      });
    }
    
    const response = await axios.post(
      `${META_API_URL}/${credential.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: cleanTo,
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.language },
          components: templateComponents.length > 0 ? templateComponents : undefined
        }
      },
      {
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { businessId: req.params.businessId, provider: 'META_CLOUD' }
    });
    
    await prisma.messageLog.create({
      data: {
        businessId: req.params.businessId,
        instanceId: instance?.id,
        direction: 'outbound',
        recipient: cleanTo,
        message: `[Template: ${template.name}]`,
        metadata: { 
          provider: 'META_CLOUD',
          template: template.name,
          variables
        }
      }
    });
    
    res.json({
      success: true,
      messageId: response.data.messages?.[0]?.id
    });
  } catch (error: any) {
    console.error('Send template error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to send template message',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

export default router;

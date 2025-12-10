import { Router, Response } from 'express';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);

async function checkBusinessAccess(userId: string, businessId: string) {
  const business = await prisma.business.findFirst({
    where: { id: businessId, userId }
  });
  return business;
}

router.get('/fields/:businessId', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const fields = await prisma.extractionField.findMany({
      where: { businessId },
      orderBy: { order: 'asc' }
    });

    if (fields.length === 0) {
      const defaultFields = [
        { fieldKey: 'nombre', fieldLabel: 'Nombre completo', required: true, order: 0 },
        { fieldKey: 'email', fieldLabel: 'Email', required: false, order: 1 },
        { fieldKey: 'direccion', fieldLabel: 'Dirección', required: false, order: 2 },
        { fieldKey: 'ciudad', fieldLabel: 'Ciudad', required: false, order: 3 },
        { fieldKey: 'telefono_alternativo', fieldLabel: 'Teléfono alternativo', required: false, order: 4 }
      ];

      await prisma.extractionField.createMany({
        data: defaultFields.map(f => ({
          businessId,
          fieldKey: f.fieldKey,
          fieldLabel: f.fieldLabel,
          fieldType: 'text',
          required: f.required,
          order: f.order,
          enabled: true
        }))
      });

      const createdFields = await prisma.extractionField.findMany({
        where: { businessId },
        orderBy: { order: 'asc' }
      });

      return res.json(createdFields);
    }

    res.json(fields);
  } catch (error) {
    console.error('Get extraction fields error:', error);
    res.status(500).json({ error: 'Failed to get extraction fields' });
  }
});

router.post('/fields/:businessId', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { fieldKey, fieldLabel, fieldType = 'text', required = false } = req.body;
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    if (!fieldKey || !fieldLabel) {
      return res.status(400).json({ error: 'fieldKey and fieldLabel are required' });
    }

    const existing = await prisma.extractionField.findUnique({
      where: {
        businessId_fieldKey: { businessId, fieldKey }
      }
    });

    if (existing) {
      return res.status(400).json({ error: 'Field with this key already exists' });
    }

    const maxOrder = await prisma.extractionField.aggregate({
      where: { businessId },
      _max: { order: true }
    });

    const field = await prisma.extractionField.create({
      data: {
        businessId,
        fieldKey: fieldKey.toLowerCase().replace(/\s+/g, '_'),
        fieldLabel,
        fieldType,
        required,
        order: (maxOrder._max.order || 0) + 1,
        enabled: true
      }
    });

    res.status(201).json(field);
  } catch (error) {
    console.error('Create extraction field error:', error);
    res.status(500).json({ error: 'Failed to create extraction field' });
  }
});

router.patch('/fields/:businessId/:fieldId', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, fieldId } = req.params;
    const { fieldLabel, required, enabled, order } = req.body;
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const existingField = await prisma.extractionField.findFirst({
      where: { id: fieldId, businessId }
    });

    if (!existingField) {
      return res.status(404).json({ error: 'Field not found' });
    }

    const field = await prisma.extractionField.update({
      where: { id: fieldId },
      data: {
        ...(fieldLabel !== undefined && { fieldLabel }),
        ...(required !== undefined && { required }),
        ...(enabled !== undefined && { enabled }),
        ...(order !== undefined && { order })
      }
    });

    res.json(field);
  } catch (error) {
    console.error('Update extraction field error:', error);
    res.status(500).json({ error: 'Failed to update extraction field' });
  }
});

router.delete('/fields/:businessId/:fieldId', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, fieldId } = req.params;
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const existingField = await prisma.extractionField.findFirst({
      where: { id: fieldId, businessId }
    });

    if (!existingField) {
      return res.status(404).json({ error: 'Field not found' });
    }

    await prisma.extractionField.delete({
      where: { id: fieldId }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Delete extraction field error:', error);
    res.status(500).json({ error: 'Failed to delete extraction field' });
  }
});

router.put('/fields/:businessId/reorder', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { fieldIds } = req.body;
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    if (!Array.isArray(fieldIds)) {
      return res.status(400).json({ error: 'fieldIds array is required' });
    }

    const existingFields = await prisma.extractionField.findMany({
      where: { businessId, id: { in: fieldIds } }
    });

    if (existingFields.length !== fieldIds.length) {
      return res.status(400).json({ error: 'Invalid field IDs' });
    }

    await Promise.all(
      fieldIds.map((id: string, index: number) =>
        prisma.extractionField.updateMany({
          where: { id, businessId },
          data: { order: index }
        })
      )
    );

    const fields = await prisma.extractionField.findMany({
      where: { businessId },
      orderBy: { order: 'asc' }
    });

    res.json(fields);
  } catch (error) {
    console.error('Reorder extraction fields error:', error);
    res.status(500).json({ error: 'Failed to reorder fields' });
  }
});

router.get('/contact/:businessId/:contactPhone', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, contactPhone } = req.params;
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const cleanPhone = contactPhone.replace(/\D/g, '');

    const extractedData = await prisma.contactExtractedData.findMany({
      where: { businessId, contactPhone: cleanPhone }
    });

    const fields = await prisma.extractionField.findMany({
      where: { businessId, enabled: true },
      orderBy: { order: 'asc' }
    });

    const dataMap: Record<string, string | null> = {};
    extractedData.forEach(d => {
      dataMap[d.fieldKey] = d.fieldValue;
    });

    const result = fields.map(field => ({
      fieldKey: field.fieldKey,
      fieldLabel: field.fieldLabel,
      fieldType: field.fieldType,
      required: field.required,
      value: dataMap[field.fieldKey] || null
    }));

    res.json(result);
  } catch (error) {
    console.error('Get contact extracted data error:', error);
    res.status(500).json({ error: 'Failed to get contact data' });
  }
});

router.patch('/contact/:businessId/:contactPhone', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, contactPhone } = req.params;
    const { data } = req.body;
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'data object is required' });
    }

    const cleanPhone = contactPhone.replace(/\D/g, '');

    const updates = Object.entries(data).map(([fieldKey, fieldValue]) =>
      prisma.contactExtractedData.upsert({
        where: {
          businessId_contactPhone_fieldKey: {
            businessId,
            contactPhone: cleanPhone,
            fieldKey
          }
        },
        create: {
          businessId,
          contactPhone: cleanPhone,
          fieldKey,
          fieldValue: fieldValue as string
        },
        update: {
          fieldValue: fieldValue as string,
          updatedAt: new Date()
        }
      })
    );

    await Promise.all(updates);

    res.json({ success: true });
  } catch (error) {
    console.error('Update contact extracted data error:', error);
    res.status(500).json({ error: 'Failed to update contact data' });
  }
});

export default router;

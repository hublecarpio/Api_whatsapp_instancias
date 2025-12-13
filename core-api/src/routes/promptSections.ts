import { Router, Response } from 'express';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/billing.js';
import OpenAI from 'openai';

const router = Router();

async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      console.warn('OPENAI_API_KEY not set, skipping embedding');
      return null;
    }

    const openai = new OpenAI({ apiKey: openaiKey });
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000)
    });

    return response.data[0].embedding;
  } catch (error) {
    console.error('Error generating embedding:', error);
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

router.get('/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const sections = await prisma.promptSection.findMany({
      where: { businessId },
      orderBy: [{ isCore: 'desc' }, { priority: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        title: true,
        content: true,
        type: true,
        isCore: true,
        priority: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
        metadata: true
      }
    });

    return res.json({ sections });
  } catch (error) {
    console.error('Error fetching prompt sections:', error);
    return res.status(500).json({ error: 'Failed to fetch sections' });
  }
});

router.get('/:businessId/:sectionId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, sectionId } = req.params;

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const section = await prisma.promptSection.findFirst({
      where: { id: sectionId, businessId }
    });

    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }

    return res.json({ section });
  } catch (error) {
    console.error('Error fetching section:', error);
    return res.status(500).json({ error: 'Failed to fetch section' });
  }
});

router.post('/:businessId', authMiddleware, requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { title, content, type = 'OTHER', isCore = false, priority = 0 } = req.body;

    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const embeddingText = `${title}. ${content}`;
    const embedding = await generateEmbedding(embeddingText);

    const section = await prisma.promptSection.create({
      data: {
        businessId,
        title,
        content,
        type,
        isCore,
        priority,
        embedding: embedding ?? undefined,
        metadata: {
          wordCount: content.split(/\s+/).length,
          hasEmbedding: !!embedding
        }
      }
    });

    return res.status(201).json({
      section: {
        id: section.id,
        title: section.title,
        content: section.content,
        type: section.type,
        isCore: section.isCore,
        priority: section.priority,
        enabled: section.enabled,
        createdAt: section.createdAt,
        metadata: section.metadata
      }
    });
  } catch (error) {
    console.error('Error creating prompt section:', error);
    return res.status(500).json({ error: 'Failed to create section' });
  }
});

router.put('/:businessId/:sectionId', authMiddleware, requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, sectionId } = req.params;
    const { title, content, type, isCore, priority, enabled } = req.body;

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const existingSection = await prisma.promptSection.findFirst({
      where: { id: sectionId, businessId }
    });

    if (!existingSection) {
      return res.status(404).json({ error: 'Section not found' });
    }

    const updateData: any = {};

    if (title !== undefined) updateData.title = title;
    if (type !== undefined) updateData.type = type;
    if (isCore !== undefined) updateData.isCore = isCore;
    if (priority !== undefined) updateData.priority = priority;
    if (enabled !== undefined) updateData.enabled = enabled;

    if (content !== undefined && content !== existingSection.content) {
      updateData.content = content;
      const embeddingText = `${title || existingSection.title}. ${content}`;
      updateData.embedding = await generateEmbedding(embeddingText);
      updateData.metadata = {
        wordCount: content.split(/\s+/).length,
        hasEmbedding: !!updateData.embedding
      };
    } else if (title !== undefined && title !== existingSection.title) {
      const embeddingText = `${title}. ${existingSection.content}`;
      updateData.embedding = await generateEmbedding(embeddingText);
      updateData.metadata = {
        ...((existingSection.metadata as any) || {}),
        hasEmbedding: !!updateData.embedding
      };
    }

    const section = await prisma.promptSection.update({
      where: { id: sectionId },
      data: updateData
    });

    return res.json({
      section: {
        id: section.id,
        title: section.title,
        content: section.content,
        type: section.type,
        isCore: section.isCore,
        priority: section.priority,
        enabled: section.enabled,
        updatedAt: section.updatedAt,
        metadata: section.metadata
      }
    });
  } catch (error) {
    console.error('Error updating section:', error);
    return res.status(500).json({ error: 'Failed to update section' });
  }
});

router.delete('/:businessId/:sectionId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, sectionId } = req.params;

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const section = await prisma.promptSection.findFirst({
      where: { id: sectionId, businessId }
    });

    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }

    await prisma.promptSection.delete({
      where: { id: sectionId }
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting section:', error);
    return res.status(500).json({ error: 'Failed to delete section' });
  }
});

router.post('/:businessId/search', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { query, limit = 3, includeCore = true } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const sections = await prisma.promptSection.findMany({
      where: { businessId, enabled: true }
    });

    if (sections.length === 0) {
      return res.json({ sections: [], context: '' });
    }

    const coreSections = sections.filter(s => s.isCore);
    const secondarySections = sections.filter(s => !s.isCore);

    let relevantSecondary: { section: any; score: number }[] = [];

    if (secondarySections.length > 0) {
      const queryEmbedding = await generateEmbedding(query);

      if (queryEmbedding) {
        relevantSecondary = secondarySections
          .filter(s => s.embedding)
          .map(section => {
            const sectionEmbedding = section.embedding as number[];
            const score = cosineSimilarity(queryEmbedding, sectionEmbedding);
            return { section, score };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      } else {
        relevantSecondary = secondarySections.slice(0, limit).map(section => ({
          section,
          score: 0.5
        }));
      }
    }

    const resultSections = includeCore
      ? [...coreSections.map(s => ({ section: s, score: 1.0 })), ...relevantSecondary]
      : relevantSecondary;

    const context = resultSections
      .map(({ section }) => `[${section.title}]: ${section.content}`)
      .join('\n\n');

    return res.json({
      sections: resultSections.map(({ section, score }) => ({
        id: section.id,
        title: section.title,
        content: section.content,
        type: section.type,
        isCore: section.isCore,
        score
      })),
      context,
      tokenEstimate: Math.ceil(context.length / 4)
    });
  } catch (error) {
    console.error('Error searching prompt sections:', error);
    return res.status(500).json({ error: 'Failed to search sections' });
  }
});

router.post('/:businessId/context', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { message, limit = 3 } = req.body;

    const internalSecret = req.headers['x-internal-secret'];
    const expectedSecret = process.env.INTERNAL_API_SECRET || 'internal-secret-key';

    let authorized = internalSecret === expectedSecret;

    if (!authorized && req.userId) {
      const business = await prisma.business.findFirst({
        where: { id: businessId, userId: req.userId }
      });
      authorized = !!business;
    }

    if (!authorized) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const sections = await prisma.promptSection.findMany({
      where: { businessId, enabled: true }
    });

    if (sections.length === 0) {
      return res.json({ 
        corePrompt: '', 
        relevantSections: [], 
        fullContext: '',
        tokenEstimate: 0
      });
    }

    const coreSections = sections.filter(s => s.isCore);
    const secondarySections = sections.filter(s => !s.isCore);

    const corePrompt = coreSections.map(s => s.content).join('\n\n');

    let relevantSections: { title: string; content: string; score: number }[] = [];

    if (message && secondarySections.length > 0) {
      const queryEmbedding = await generateEmbedding(message);

      if (queryEmbedding) {
        relevantSections = secondarySections
          .filter(s => s.embedding)
          .map(section => {
            const sectionEmbedding = section.embedding as number[];
            const score = cosineSimilarity(queryEmbedding, sectionEmbedding);
            return { 
              title: section.title, 
              content: section.content, 
              score 
            };
          })
          .filter(s => s.score > 0.3)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      }
    }

    const relevantContext = relevantSections
      .map(s => `[${s.title}]: ${s.content}`)
      .join('\n\n');

    const fullContext = corePrompt + (relevantContext ? '\n\n' + relevantContext : '');

    return res.json({
      corePrompt,
      relevantSections,
      fullContext,
      tokenEstimate: Math.ceil(fullContext.length / 4)
    });
  } catch (error) {
    console.error('Error getting prompt context:', error);
    return res.status(500).json({ error: 'Failed to get context' });
  }
});

export default router;

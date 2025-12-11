import { Router, Response } from 'express';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/billing.js';
import OpenAI from 'openai';

const router = Router();

const MAX_CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

function chunkText(text: string, maxSize: number = MAX_CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let currentChunk = '';

  for (const sentence of sentences) {
    if ((currentChunk + ' ' + sentence).length > maxSize && currentChunk) {
      chunks.push(currentChunk.trim());
      const words = currentChunk.split(' ');
      const overlapWords = words.slice(-Math.floor(overlap / 5));
      currentChunk = overlapWords.join(' ') + ' ' + sentence;
    } else {
      currentChunk = currentChunk ? currentChunk + ' ' + sentence : sentence;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

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

router.get('/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const documents = await prisma.knowledgeDocument.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        type: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
        metadata: true
      }
    });

    return res.json({ documents });
  } catch (error) {
    console.error('Error fetching knowledge documents:', error);
    return res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

router.get('/:businessId/:documentId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, documentId } = req.params;

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const document = await prisma.knowledgeDocument.findFirst({
      where: { id: documentId, businessId }
    });

    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    return res.json({ document });
  } catch (error) {
    console.error('Error fetching document:', error);
    return res.status(500).json({ error: 'Failed to fetch document' });
  }
});

router.post('/:businessId', authMiddleware, requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { title, content, type = 'TEXT' } = req.body;

    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const chunks = chunkText(content);
    const summaryForEmbedding = `${title}. ${content.slice(0, 2000)}`;
    const embedding = await generateEmbedding(summaryForEmbedding);

    const document = await prisma.knowledgeDocument.create({
      data: {
        businessId,
        title,
        content,
        type,
        chunks: chunks,
        embedding: embedding ?? undefined,
        metadata: {
          wordCount: content.split(/\s+/).length,
          chunkCount: chunks.length,
          hasEmbedding: !!embedding
        }
      }
    });

    return res.status(201).json({
      document: {
        id: document.id,
        title: document.title,
        type: document.type,
        enabled: document.enabled,
        createdAt: document.createdAt,
        metadata: document.metadata
      }
    });
  } catch (error) {
    console.error('Error creating knowledge document:', error);
    return res.status(500).json({ error: 'Failed to create document' });
  }
});

router.put('/:businessId/:documentId', authMiddleware, requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, documentId } = req.params;
    const { title, content, type, enabled } = req.body;

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const existingDoc = await prisma.knowledgeDocument.findFirst({
      where: { id: documentId, businessId }
    });

    if (!existingDoc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const updateData: any = {};

    if (title !== undefined) updateData.title = title;
    if (type !== undefined) updateData.type = type;
    if (enabled !== undefined) updateData.enabled = enabled;

    if (content !== undefined && content !== existingDoc.content) {
      updateData.content = content;
      updateData.chunks = chunkText(content);
      const summaryForEmbedding = `${title || existingDoc.title}. ${content.slice(0, 2000)}`;
      updateData.embedding = await generateEmbedding(summaryForEmbedding);
      updateData.metadata = {
        wordCount: content.split(/\s+/).length,
        chunkCount: updateData.chunks.length,
        hasEmbedding: !!updateData.embedding
      };
    }

    const document = await prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: updateData
    });

    return res.json({
      document: {
        id: document.id,
        title: document.title,
        type: document.type,
        enabled: document.enabled,
        updatedAt: document.updatedAt,
        metadata: document.metadata
      }
    });
  } catch (error) {
    console.error('Error updating document:', error);
    return res.status(500).json({ error: 'Failed to update document' });
  }
});

router.delete('/:businessId/:documentId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, documentId } = req.params;

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const document = await prisma.knowledgeDocument.findFirst({
      where: { id: documentId, businessId }
    });

    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    await prisma.knowledgeDocument.delete({
      where: { id: documentId }
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting document:', error);
    return res.status(500).json({ error: 'Failed to delete document' });
  }
});

router.post('/:businessId/search', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { query, limit = 3 } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const documents = await prisma.knowledgeDocument.findMany({
      where: { businessId, enabled: true }
    });

    if (documents.length === 0) {
      return res.json({ results: [], context: '' });
    }

    const queryEmbedding = await generateEmbedding(query);

    if (!queryEmbedding) {
      const results = documents.slice(0, limit).map(doc => ({
        id: doc.id,
        title: doc.title,
        snippet: doc.content.slice(0, 500),
        score: 0.5
      }));

      const context = results.map(r => `[${r.title}]: ${r.snippet}`).join('\n\n');
      return res.json({ results, context });
    }

    const docsWithScores = documents
      .filter(doc => doc.embedding)
      .map(doc => {
        const docEmbedding = doc.embedding as number[];
        const score = cosineSimilarity(queryEmbedding, docEmbedding);
        return { doc, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const results = docsWithScores.map(({ doc, score }) => ({
      id: doc.id,
      title: doc.title,
      snippet: doc.content.slice(0, 500),
      score
    }));

    const context = docsWithScores
      .map(({ doc }) => `[${doc.title}]: ${doc.content.slice(0, 1000)}`)
      .join('\n\n');

    return res.json({ results, context });
  } catch (error) {
    console.error('Error searching knowledge:', error);
    return res.status(500).json({ error: 'Failed to search' });
  }
});

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

export default router;

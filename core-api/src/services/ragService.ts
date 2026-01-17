import prisma from './prisma.js';
import OpenAI from 'openai';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const MAX_RAG_SECTIONS = 5;
const MIN_SIMILARITY_THRESHOLD = 0.3;

interface RetrievedSection {
  id: string;
  title: string;
  content: string;
  type: string;
  isCore: boolean;
  similarity?: number;
}

interface RAGResult {
  coreSections: RetrievedSection[];
  ragSections: RetrievedSection[];
  totalTokensEstimate: number;
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      console.warn('[RAG] OPENAI_API_KEY not set, skipping embedding');
      return null;
    }

    const openai = new OpenAI({ apiKey: openaiKey });
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000)
    });

    return response.data[0].embedding;
  } catch (error) {
    console.error('[RAG] Error generating embedding:', error);
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;

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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function retrieveRelevantSections(
  businessId: string,
  query: string,
  maxRagSections: number = MAX_RAG_SECTIONS,
  instanceId?: string
): Promise<RAGResult> {
  const startTime = Date.now();
  
  const sections = await prisma.promptSection.findMany({
    where: { 
      businessId, 
      enabled: true,
      OR: [
        { instanceId: instanceId || null },
        { instanceId: null }
      ]
    },
    select: {
      id: true,
      title: true,
      content: true,
      type: true,
      isCore: true,
      embedding: true,
      instanceId: true
    }
  });

  const coreSections: RetrievedSection[] = [];
  const candidateSections: (RetrievedSection & { similarity: number })[] = [];

  const ragCandidates = sections.filter(s => !s.isCore);
  const withEmbeddings = ragCandidates.filter(s => s.embedding);
  const withoutEmbeddings = ragCandidates.filter(s => !s.embedding);
  
  if (withoutEmbeddings.length > 0) {
    console.log(`[RAG] Generating embeddings for ${withoutEmbeddings.length} sections`);
    const batchSize = 10;
    
    for (let i = 0; i < withoutEmbeddings.length; i += batchSize) {
      const batch = withoutEmbeddings.slice(i, i + batchSize);
      await Promise.all(batch.map(async (section) => {
        try {
          const text = `${section.title}\n${section.content}`;
          const embedding = await generateEmbedding(text);
          if (embedding) {
            await prisma.promptSection.update({
              where: { id: section.id },
              data: { embedding }
            });
            section.embedding = embedding as any;
          }
        } catch (e) {
          console.warn(`[RAG] Failed to generate embedding for section ${section.id}:`, e);
        }
      }));
    }
    console.log(`[RAG] Finished generating embeddings for ${withoutEmbeddings.length} sections`);
  }
  
  let queryEmbedding: number[] | null = null;
  const sectionsWithEmbeddings = sections.filter(s => !s.isCore && s.embedding);
  if (sectionsWithEmbeddings.length > 0) {
    queryEmbedding = await generateEmbedding(query);
  }

  for (const section of sections) {
    const sectionData: RetrievedSection = {
      id: section.id,
      title: section.title,
      content: section.content,
      type: section.type,
      isCore: section.isCore
    };

    if (section.isCore) {
      coreSections.push(sectionData);
    } else if (queryEmbedding && section.embedding) {
      let embeddingArray: number[];
      try {
        if (Array.isArray(section.embedding)) {
          embeddingArray = (section.embedding as any[]).map((v: any) => {
            if (typeof v === 'number') return v;
            if (v && typeof v.valueOf === 'function') return Number(v.valueOf());
            if (v && typeof v.toNumber === 'function') return v.toNumber();
            const parsed = Number(v);
            return isNaN(parsed) ? 0 : parsed;
          });
        } else {
          console.warn(`[RAG] Invalid embedding format for section ${section.id}, skipping`);
          continue;
        }
      } catch (e) {
        console.warn(`[RAG] Failed to parse embedding for section ${section.id}:`, e);
        continue;
      }
      
      const similarity = cosineSimilarity(queryEmbedding, embeddingArray);
      
      if (similarity >= MIN_SIMILARITY_THRESHOLD && !isNaN(similarity)) {
        candidateSections.push({ ...sectionData, similarity });
      }
    }
  }

  candidateSections.sort((a, b) => b.similarity - a.similarity);
  const ragSections: RetrievedSection[] = candidateSections.slice(0, maxRagSections).map(s => ({
    ...s,
    similarity: s.similarity
  }));

  let totalTokens = 0;
  for (const s of coreSections) {
    totalTokens += estimateTokens(s.content);
  }
  for (const s of ragSections) {
    totalTokens += estimateTokens(s.content);
  }

  const duration = Date.now() - startTime;
  console.log(`[RAG] Retrieved ${coreSections.length} core + ${ragSections.length} RAG sections in ${duration}ms (~${totalTokens} tokens)`);

  return {
    coreSections,
    ragSections,
    totalTokensEstimate: totalTokens
  };
}

export function formatSectionsForPrompt(result: RAGResult): string {
  const parts: string[] = [];

  if (result.coreSections.length > 0) {
    parts.push('=== CONOCIMIENTO BASE ===');
    for (const section of result.coreSections) {
      parts.push(`\n## ${section.title}\n${section.content}`);
    }
  }

  if (result.ragSections.length > 0) {
    parts.push('\n\n=== CONTEXTO RELEVANTE ===');
    for (const section of result.ragSections) {
      const similarityInfo = section.similarity ? ` (relevancia: ${(section.similarity * 100).toFixed(0)}%)` : '';
      parts.push(`\n## ${section.title}${similarityInfo}\n${section.content}`);
    }
  }

  return parts.join('\n');
}

export async function ensureSectionEmbeddings(businessId: string): Promise<number> {
  const allSections = await prisma.promptSection.findMany({
    where: { 
      businessId, 
      enabled: true,
      isCore: false
    },
    select: { id: true, title: true, content: true, embedding: true }
  });
  
  const sectionsWithoutEmbedding = allSections.filter(s => !s.embedding);

  let updated = 0;
  for (const section of sectionsWithoutEmbedding) {
    const text = `${section.title}\n${section.content}`;
    const embedding = await generateEmbedding(text);
    
    if (embedding) {
      await prisma.promptSection.update({
        where: { id: section.id },
        data: { embedding }
      });
      updated++;
    }
  }

  if (updated > 0) {
    console.log(`[RAG] Generated embeddings for ${updated} sections`);
  }

  return updated;
}

export async function getRAGStats(businessId: string): Promise<{
  totalSections: number;
  coreSections: number;
  ragSections: number;
  withEmbeddings: number;
  withoutEmbeddings: number;
}> {
  const sections = await prisma.promptSection.findMany({
    where: { businessId, enabled: true },
    select: { isCore: true, embedding: true }
  });

  const coreSections = sections.filter(s => s.isCore).length;
  const ragSections = sections.filter(s => !s.isCore).length;
  const withEmbeddings = sections.filter(s => !s.isCore && s.embedding).length;
  const withoutEmbeddings = sections.filter(s => !s.isCore && !s.embedding).length;

  return {
    totalSections: sections.length,
    coreSections,
    ragSections,
    withEmbeddings,
    withoutEmbeddings
  };
}

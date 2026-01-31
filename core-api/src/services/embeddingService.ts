import OpenAI from 'openai';
import prisma from './prisma.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

export function buildProductEmbeddingText(product: {
  title: string;
  description?: string | null;
  variations?: string[];
  price?: number;
}): string {
  const parts: string[] = [];
  
  parts.push(`Producto: ${product.title}`);
  
  if (product.description) {
    parts.push(`Descripción: ${product.description}`);
  }
  
  if (product.variations && product.variations.length > 0) {
    parts.push(`Variaciones: ${product.variations.join(', ')}`);
  }
  
  if (product.price !== undefined && product.price > 0) {
    parts.push(`Precio: ${product.price}`);
  }
  
  return parts.join('. ');
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS
  });
  
  return response.data[0].embedding;
}

export async function updateProductEmbedding(productId: string): Promise<boolean> {
  try {
    const product = await prisma.product.findUnique({
      where: { id: productId }
    });
    
    if (!product) {
      console.log(`[Embedding] Product ${productId} not found`);
      return false;
    }
    
    const embeddingText = buildProductEmbeddingText(product);
    const embedding = await generateEmbedding(embeddingText);
    const vectorString = `[${embedding.join(',')}]`;
    
    await prisma.$executeRawUnsafe(`
      UPDATE "Product"
      SET 
        embedding = $1::vector,
        "embeddingText" = $2,
        "embeddingUpdatedAt" = NOW()
      WHERE id = $3
    `, vectorString, embeddingText, productId);
    
    console.log(`[Embedding] ✅ Updated embedding for product: ${product.title.substring(0, 30)}...`);
    return true;
  } catch (error) {
    console.error(`[Embedding] ❌ Error updating product ${productId}:`, error);
    return false;
  }
}

export async function updateAllProductEmbeddings(
  businessId?: string,
  batchSize: number = 10,
  onProgress?: (current: number, total: number) => void
): Promise<{ updated: number; failed: number; total: number }> {
  const whereClause: any = {};
  if (businessId) {
    whereClause.businessId = businessId;
  }
  
  const products = await prisma.product.findMany({
    where: whereClause,
    select: { id: true, title: true, description: true, variations: true, price: true }
  });
  
  let updated = 0;
  let failed = 0;
  const total = products.length;
  
  console.log(`[Embedding] Starting batch update for ${total} products`);
  
  for (let i = 0; i < products.length; i += batchSize) {
    const batch = products.slice(i, i + batchSize);
    
    const results = await Promise.all(
      batch.map(async (product) => {
        try {
          const embeddingText = buildProductEmbeddingText(product);
          const embedding = await generateEmbedding(embeddingText);
          const vectorString = `[${embedding.join(',')}]`;
          
          await prisma.$executeRawUnsafe(`
            UPDATE "Product"
            SET 
              embedding = $1::vector,
              "embeddingText" = $2,
              "embeddingUpdatedAt" = NOW()
            WHERE id = $3
          `, vectorString, embeddingText, product.id);
          
          return true;
        } catch (error) {
          console.error(`[Embedding] Failed for ${product.id}:`, error);
          return false;
        }
      })
    );
    
    const batchUpdated = results.filter(r => r).length;
    const batchFailed = results.filter(r => !r).length;
    
    updated += batchUpdated;
    failed += batchFailed;
    
    if (onProgress) {
      onProgress(i + batch.length, total);
    }
    
    console.log(`[Embedding] Progress: ${i + batch.length}/${total} (${batchUpdated} updated, ${batchFailed} failed in batch)`);
    
    if (i + batchSize < products.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  
  console.log(`[Embedding] ✅ Batch update complete: ${updated} updated, ${failed} failed out of ${total}`);
  
  return { updated, failed, total };
}

export async function searchProductsBySemantic(
  businessId: string,
  query: string,
  limit: number = 5,
  instanceId?: string | null,
  minSimilarity: number = 0.3
): Promise<Array<{
  id: string;
  title: string;
  description: string | null;
  variations: string[];
  pricePerVariation: number[];
  stockPerVariation: number[];
  imageUrls: string[];
  price: number;
  stock: number;
  imageUrl: string | null;
  similarity: number;
}>> {
  try {
    const queryEmbedding = await generateEmbedding(query);
    const vectorString = `[${queryEmbedding.join(',')}]`;
    
    let instanceFilter = '';
    const params: any[] = [vectorString, businessId, minSimilarity, limit];
    
    if (instanceId) {
      instanceFilter = `AND ("instanceId" = $5 OR "instanceId" IS NULL)`;
      params.push(instanceId);
    }
    
    const results = await prisma.$queryRawUnsafe<Array<{
      id: string;
      title: string;
      description: string | null;
      variations: string[];
      pricePerVariation: number[];
      stockPerVariation: number[];
      imageUrls: string[];
      price: number;
      stock: number;
      imageUrl: string | null;
      similarity: number;
    }>>(`
      SELECT 
        id,
        title,
        description,
        variations,
        "pricePerVariation",
        "stockPerVariation",
        "imageUrls",
        price,
        stock,
        "imageUrl",
        1 - (embedding <=> $1::vector) as similarity
      FROM "Product"
      WHERE 
        "businessId" = $2
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> $1::vector) >= $3
        ${instanceFilter}
      ORDER BY embedding <=> $1::vector
      LIMIT $4
    `, ...params);
    
    return results;
  } catch (error) {
    console.error('[Embedding] Semantic search error:', error);
    return [];
  }
}

export async function getProductsWithoutEmbeddings(
  businessId?: string,
  limit: number = 100
): Promise<Array<{ id: string; title: string }>> {
  const safeLimit = Math.max(1, Math.min(1000, limit));
  
  if (businessId) {
    const products = await prisma.$queryRaw<Array<{ id: string; title: string }>>`
      SELECT id, title
      FROM "Product"
      WHERE embedding IS NULL
        AND "businessId" = ${businessId}
      LIMIT ${safeLimit}
    `;
    return products;
  } else {
    const products = await prisma.$queryRaw<Array<{ id: string; title: string }>>`
      SELECT id, title
      FROM "Product"
      WHERE embedding IS NULL
      LIMIT ${safeLimit}
    `;
    return products;
  }
}

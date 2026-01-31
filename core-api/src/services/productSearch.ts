import prisma from './prisma.js';
import { searchProductsBySemantic } from './embeddingService.js';

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

function calculateSimilarity(query: string, target: string): number {
  const normalizedQuery = normalizeText(query);
  const normalizedTarget = normalizeText(target);

  if (normalizedTarget.includes(normalizedQuery)) {
    return 1.0;
  }

  if (normalizedQuery.includes(normalizedTarget)) {
    return 0.95;
  }

  const queryTokens = normalizedQuery.split(' ').filter(t => t.length > 1);
  const targetTokens = normalizedTarget.split(' ').filter(t => t.length > 1);

  let matchedTokens = 0;
  let partialMatches = 0;

  for (const qToken of queryTokens) {
    for (const tToken of targetTokens) {
      if (tToken === qToken) {
        matchedTokens++;
        break;
      } else if (tToken.includes(qToken) || qToken.includes(tToken)) {
        partialMatches += 0.7;
        break;
      } else {
        const distance = levenshteinDistance(qToken, tToken);
        const maxLen = Math.max(qToken.length, tToken.length);
        const similarity = 1 - (distance / maxLen);
        if (similarity >= 0.7) {
          partialMatches += similarity * 0.5;
          break;
        }
      }
    }
  }

  const tokenScore = queryTokens.length > 0 
    ? (matchedTokens + partialMatches) / queryTokens.length 
    : 0;

  const maxLen = Math.max(normalizedQuery.length, normalizedTarget.length);
  const distance = levenshteinDistance(normalizedQuery, normalizedTarget);
  const directSimilarity = 1 - (distance / maxLen);

  return Math.max(tokenScore, directSimilarity);
}

interface SearchResult {
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
  available: boolean;
  similarity: number;
  matchedVariation?: string;
  matchedVariationIndex?: number;
  searchMethod?: 'semantic' | 'fuzzy' | 'hybrid';
}

function fuzzySearchProducts(
  allProducts: any[],
  query: string
): SearchResult[] {
  const scoredProducts = allProducts.map(product => {
    const titleSimilarity = calculateSimilarity(query, product.title);
    const descSimilarity = product.description 
      ? calculateSimilarity(query, product.description) * 0.5
      : 0;
    
    let variationSimilarity = 0;
    let matchedVariation: string | undefined;
    let matchedVariationIndex: number | undefined;
    
    if (product.variations && product.variations.length > 0) {
      for (let i = 0; i < product.variations.length; i++) {
        const varSim = calculateSimilarity(query, product.variations[i]) * 0.8;
        if (varSim > variationSimilarity) {
          variationSimilarity = varSim;
          matchedVariation = product.variations[i];
          matchedVariationIndex = i;
        }
        const combinedSim = calculateSimilarity(query, `${product.title} ${product.variations[i]}`) * 0.9;
        if (combinedSim > variationSimilarity) {
          variationSimilarity = combinedSim;
          matchedVariation = product.variations[i];
          matchedVariationIndex = i;
        }
      }
    }
    
    const similarity = Math.max(titleSimilarity, descSimilarity, variationSimilarity);
    const productImageUrl = product.imageUrl || (product.imageUrls && product.imageUrls.length > 0 ? product.imageUrls[0] : null);
    
    return {
      id: product.id,
      title: product.title,
      description: product.description,
      variations: product.variations || [],
      pricePerVariation: product.pricePerVariation || [],
      stockPerVariation: product.stockPerVariation || [],
      imageUrls: product.imageUrls || [],
      price: product.price,
      stock: product.stock,
      imageUrl: productImageUrl,
      available: product.stock > 0,
      similarity,
      matchedVariation,
      matchedVariationIndex,
      searchMethod: 'fuzzy' as const
    };
  });

  scoredProducts.sort((a, b) => b.similarity - a.similarity);
  return scoredProducts.filter(p => p.similarity >= 0.3);
}

export async function searchProductsIntelligent(
  businessId: string,
  query: string,
  limit: number = 5,
  instanceId?: string | null,
  useSemanticSearch: boolean = true
): Promise<{
  products: SearchResult[];
  exactMatch: boolean;
  bestMatch: SearchResult | null;
  searchMethod: 'semantic' | 'fuzzy' | 'hybrid';
}> {
  console.log(`[productSearch] ─────────────────────────────────────────────`);
  console.log(`[productSearch] 🔍 Query: "${query}"`);
  console.log(`[productSearch] 📋 Filters: businessId=${businessId?.slice(0, 8)}..., instanceId=${instanceId?.slice(0, 8) || 'ANY'}`);
  console.log(`[productSearch] 🧠 Semantic search: ${useSemanticSearch ? 'ENABLED' : 'DISABLED'}`);
  
  let semanticResults: SearchResult[] = [];
  let searchMethod: 'semantic' | 'fuzzy' | 'hybrid' = 'fuzzy';
  
  if (useSemanticSearch && process.env.OPENAI_API_KEY) {
    try {
      console.log(`[productSearch] 🔮 Running semantic search...`);
      const semanticProducts = await searchProductsBySemantic(
        businessId,
        query,
        limit * 2,
        instanceId,
        0.35
      );
      
      if (semanticProducts.length > 0) {
        semanticResults = semanticProducts.map(p => ({
          ...p,
          available: p.stock > 0,
          searchMethod: 'semantic' as const
        }));
        console.log(`[productSearch] 🔮 Semantic found: ${semanticResults.length} products`);
        console.log(`[productSearch] 🔮 Top semantic: ${semanticResults.slice(0, 3).map(p => `${p.title} (${(p.similarity * 100).toFixed(1)}%)`).join(', ')}`);
      }
    } catch (error) {
      console.log(`[productSearch] ⚠️ Semantic search failed, falling back to fuzzy:`, error);
    }
  }
  
  const whereClause: any = { businessId };
  if (instanceId) {
    whereClause.OR = [
      { instanceId },
      { instanceId: null }
    ];
  }
  
  const allProducts = await prisma.product.findMany({
    where: whereClause
  });
  
  console.log(`[productSearch] 📦 DB returned: ${allProducts.length} products total`);
  
  const fuzzyResults = fuzzySearchProducts(allProducts, query);
  console.log(`[productSearch] 📝 Fuzzy found: ${fuzzyResults.length} products`);
  if (fuzzyResults.length > 0) {
    console.log(`[productSearch] 📝 Top fuzzy: ${fuzzyResults.slice(0, 3).map(p => `${p.title} (${(p.similarity * 100).toFixed(1)}%)`).join(', ')}`);
  }
  
  let finalResults: SearchResult[] = [];
  
  if (semanticResults.length > 0 && fuzzyResults.length > 0) {
    searchMethod = 'hybrid';
    
    const productScores = new Map<string, { product: SearchResult; semanticScore: number; fuzzyScore: number }>();
    
    for (const product of semanticResults) {
      productScores.set(product.id, {
        product,
        semanticScore: product.similarity,
        fuzzyScore: 0
      });
    }
    
    for (const product of fuzzyResults) {
      const existing = productScores.get(product.id);
      if (existing) {
        existing.fuzzyScore = product.similarity;
        if (product.matchedVariation) {
          existing.product.matchedVariation = product.matchedVariation;
          existing.product.matchedVariationIndex = product.matchedVariationIndex;
        }
      } else {
        productScores.set(product.id, {
          product: { ...product, searchMethod: 'fuzzy' },
          semanticScore: 0,
          fuzzyScore: product.similarity
        });
      }
    }
    
    const combinedResults = Array.from(productScores.values()).map(({ product, semanticScore, fuzzyScore }) => {
      const combinedScore = (semanticScore * 0.6) + (fuzzyScore * 0.4);
      return {
        ...product,
        similarity: combinedScore,
        searchMethod: (semanticScore > 0 && fuzzyScore > 0 ? 'hybrid' : 
                       semanticScore > 0 ? 'semantic' : 'fuzzy') as 'semantic' | 'fuzzy' | 'hybrid'
      };
    });
    
    combinedResults.sort((a, b) => b.similarity - a.similarity);
    finalResults = combinedResults.slice(0, limit);
    
    console.log(`[productSearch] 🔀 Hybrid results: ${finalResults.length} products (semantic weight: 60%, fuzzy weight: 40%)`);
  } else if (semanticResults.length > 0) {
    searchMethod = 'semantic';
    finalResults = semanticResults.slice(0, limit);
    console.log(`[productSearch] 🔮 Using semantic results only`);
  } else {
    searchMethod = 'fuzzy';
    finalResults = fuzzyResults.slice(0, limit);
    console.log(`[productSearch] 📝 Using fuzzy results only`);
  }
  
  if (finalResults.length > 0) {
    console.log(`[productSearch] ✅ Final results (${searchMethod}):`);
    finalResults.forEach((p, i) => {
      console.log(`[productSearch]   ${i + 1}. ${p.title} - ${(p.similarity * 100).toFixed(1)}% [${p.searchMethod}]`);
    });
  } else {
    console.log(`[productSearch] ⚠️ No products found for "${query}"`);
  }

  const exactMatch = finalResults.length > 0 && finalResults[0].similarity >= 0.9;
  const bestMatch = finalResults.length > 0 ? finalResults[0] : null;

  return {
    products: finalResults,
    exactMatch,
    bestMatch,
    searchMethod
  };
}

export async function findBestProductMatch(
  businessId: string,
  query: string,
  instanceId?: string | null
): Promise<SearchResult | null> {
  const result = await searchProductsIntelligent(businessId, query, 1, instanceId);
  
  if (result.bestMatch && result.bestMatch.similarity >= 0.4) {
    return result.bestMatch;
  }
  
  return null;
}

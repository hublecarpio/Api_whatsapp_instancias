import prisma from './prisma.js';

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
  price: number;
  stock: number;
  imageUrl: string | null;
  available: boolean;
  similarity: number;
}

export async function searchProductsIntelligent(
  businessId: string,
  query: string,
  limit: number = 5
): Promise<{
  products: SearchResult[];
  exactMatch: boolean;
  bestMatch: SearchResult | null;
}> {
  const allProducts = await prisma.product.findMany({
    where: { businessId }
  });

  const normalizedQuery = normalizeText(query);

  const scoredProducts = allProducts.map(product => {
    const titleSimilarity = calculateSimilarity(query, product.title);
    const descSimilarity = product.description 
      ? calculateSimilarity(query, product.description) * 0.5
      : 0;
    
    const similarity = Math.max(titleSimilarity, descSimilarity);

    return {
      id: product.id,
      title: product.title,
      description: product.description,
      price: product.price,
      stock: product.stock,
      imageUrl: product.imageUrl,
      available: product.stock > 0,
      similarity
    };
  });

  scoredProducts.sort((a, b) => b.similarity - a.similarity);

  const relevantProducts = scoredProducts.filter(p => p.similarity >= 0.3);

  const topProducts = relevantProducts.slice(0, limit);

  const exactMatch = topProducts.length > 0 && topProducts[0].similarity >= 0.9;
  const bestMatch = topProducts.length > 0 ? topProducts[0] : null;

  return {
    products: topProducts,
    exactMatch,
    bestMatch
  };
}

export async function findBestProductMatch(
  businessId: string,
  query: string
): Promise<SearchResult | null> {
  const result = await searchProductsIntelligent(businessId, query, 1);
  
  if (result.bestMatch && result.bestMatch.similarity >= 0.4) {
    return result.bestMatch;
  }
  
  return null;
}

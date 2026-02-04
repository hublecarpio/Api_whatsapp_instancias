import prisma from './prisma.js';
import { randomBytes } from 'crypto';

const SHORT_ID_LENGTH = 12;
const ALPHANUMERIC_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function generateShortId(): string {
  const bytes = randomBytes(SHORT_ID_LENGTH);
  let result = '';
  for (let i = 0; i < SHORT_ID_LENGTH; i++) {
    result += ALPHANUMERIC_CHARS[bytes[i] % ALPHANUMERIC_CHARS.length];
  }
  return result;
}

export interface CreateShortUrlResult {
  shortId: string;
  shortUrl: string;
  originalUrl: string;
}

export async function createShortUrl(
  originalUrl: string,
  businessId?: string,
  mediaType?: string
): Promise<CreateShortUrlResult> {
  // Priority: NEXT_PUBLIC_API_URL > REPLIT_DEV_DOMAIN > localhost
  let baseUrl: string;
  if (process.env.NEXT_PUBLIC_API_URL) {
    baseUrl = process.env.NEXT_PUBLIC_API_URL;
  } else if (process.env.REPLIT_DEV_DOMAIN) {
    baseUrl = `https://${process.env.REPLIT_DEV_DOMAIN}`;
  } else {
    baseUrl = 'http://localhost:3001';
  }
  
  let shortId = generateShortId();
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    try {
      await prisma.mediaShortUrl.create({
        data: {
          shortId,
          originalUrl,
          businessId: businessId || null,
          mediaType: mediaType || null,
        }
      });
      
      const shortUrl = `${baseUrl}/m/${shortId}`;
      console.log(`[SHORT_URL] Created: ${shortId} -> ${originalUrl.substring(0, 60)}...`);
      
      return {
        shortId,
        shortUrl,
        originalUrl
      };
    } catch (error: any) {
      if (error.code === 'P2002') {
        shortId = generateShortId();
        attempts++;
        continue;
      }
      throw error;
    }
  }
  
  throw new Error('Failed to generate unique short ID after max attempts');
}

export async function resolveShortUrl(shortId: string): Promise<string | null> {
  const record = await prisma.mediaShortUrl.findUnique({
    where: { shortId },
    select: { originalUrl: true }
  });
  
  return record?.originalUrl || null;
}

export async function cleanupOldShortUrls(daysOld: number = 30): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);
  
  const result = await prisma.mediaShortUrl.deleteMany({
    where: {
      createdAt: {
        lt: cutoffDate
      }
    }
  });
  
  console.log(`[SHORT_URL] Cleaned up ${result.count} old short URLs (older than ${daysOld} days)`);
  return result.count;
}

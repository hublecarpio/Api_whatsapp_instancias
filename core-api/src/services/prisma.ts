import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DATABASE_URL;

// Configure connection pool with better settings for production
const poolUrl = databaseUrl ? 
  (databaseUrl.includes('?') ? 
    `${databaseUrl}&connection_limit=20&pool_timeout=30&connect_timeout=30` : 
    `${databaseUrl}?connection_limit=20&pool_timeout=30&connect_timeout=30`) 
  : undefined;

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: poolUrl || databaseUrl
    }
  },
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
});

// Retry wrapper for database operations
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      
      // Check if it's a connection error that might be retryable
      const isConnectionError = 
        error.code === 'P1017' || // Server has closed the connection
        error.code === 'P1001' || // Can't reach database server
        error.code === 'P1002' || // Database server timeout
        error.message?.includes('Server has closed the connection') ||
        error.message?.includes('Connection refused') ||
        error.message?.includes('ECONNRESET');
      
      if (!isConnectionError || attempt === maxRetries) {
        throw error;
      }
      
      console.warn(`[Prisma] Connection error on attempt ${attempt}/${maxRetries}, retrying in ${delayMs}ms...`, error.code || error.message);
      
      // Try to disconnect and reconnect
      try {
        await prisma.$disconnect();
      } catch (disconnectError) {
        // Ignore disconnect errors
      }
      
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
  
  throw lastError;
}

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

export default prisma;


import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function ensureRequiredTables(): Promise<void> {
  console.log('[DB-INIT] Checking for required tables...');
  
  try {
    await ensureVectorExtension();
    await ensureProductEmbeddingColumns();
    await ensureWebhookRawLogTable();
    console.log('[DB-INIT] All required tables verified/created successfully');
  } catch (error: any) {
    console.error('[DB-INIT] Error ensuring tables:', error.message);
    throw error;
  }
}

async function ensureVectorExtension(): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    console.log('[DB-INIT] Vector extension ensured');
  } catch (error: any) {
    console.warn('[DB-INIT] Could not create vector extension (may already exist or not available):', error.message);
  }
}

async function ensureProductEmbeddingColumns(): Promise<void> {
  const tableName = 'Product';
  
  try {
    const columnCheck = await prisma.$queryRaw<Array<{column_name: string}>>`
      SELECT column_name FROM information_schema.columns 
      WHERE table_schema = 'public' 
      AND table_name = ${tableName}
      AND column_name IN ('embeddingText', 'embeddingUpdatedAt', 'embedding')
    `;
    
    const existingColumns = new Set(columnCheck.map(c => c.column_name));
    
    if (!existingColumns.has('embeddingText')) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "embeddingText" TEXT`);
      console.log('[DB-INIT] Added embeddingText column to Product');
    }
    
    if (!existingColumns.has('embeddingUpdatedAt')) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "embeddingUpdatedAt" TIMESTAMP(3)`);
      console.log('[DB-INIT] Added embeddingUpdatedAt column to Product');
    }
    
    if (!existingColumns.has('embedding')) {
      try {
        await prisma.$executeRawUnsafe(`ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "embedding" vector(1536)`);
        console.log('[DB-INIT] Added embedding column to Product');
      } catch (err: any) {
        console.warn('[DB-INIT] Could not add vector column (extension may not be available):', err.message);
      }
    }
    
    console.log(`[DB-INIT] Product embedding columns verified`);
  } catch (error: any) {
    console.error(`[DB-INIT] Error checking Product columns:`, error.message);
  }
}

async function ensureWebhookRawLogTable(): Promise<void> {
  const tableName = 'WebhookRawLog';
  
  try {
    const tableExists = await prisma.$queryRaw<Array<{exists: boolean}>>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = ${tableName}
      ) as exists
    `;
    
    if (tableExists[0]?.exists) {
      console.log(`[DB-INIT] Table ${tableName} already exists`);
      return;
    }
    
    console.log(`[DB-INIT] Creating table ${tableName}...`);
    
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "WebhookRawLog" (
        "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "source" TEXT NOT NULL DEFAULT 'META',
        "endpoint" TEXT NOT NULL,
        "method" TEXT NOT NULL DEFAULT 'POST',
        "headers" JSONB,
        "queryParams" JSONB,
        "body" JSONB NOT NULL,
        "phoneNumberId" TEXT,
        "businessId" TEXT,
        "instanceId" TEXT,
        "messageCount" INTEGER NOT NULL DEFAULT 0,
        "statusCount" INTEGER NOT NULL DEFAULT 0,
        "processingError" TEXT,
        "processedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "WebhookRawLog_pkey" PRIMARY KEY ("id")
      )
    `);
    
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "WebhookRawLog_source_createdAt_idx" 
      ON "WebhookRawLog"("source", "createdAt")
    `);
    
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "WebhookRawLog_phoneNumberId_createdAt_idx" 
      ON "WebhookRawLog"("phoneNumberId", "createdAt")
    `);
    
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "WebhookRawLog_businessId_createdAt_idx" 
      ON "WebhookRawLog"("businessId", "createdAt")
    `);
    
    console.log(`[DB-INIT] Table ${tableName} created successfully with indexes`);
    
  } catch (error: any) {
    console.error(`[DB-INIT] Failed to create table ${tableName}:`, error.message);
    throw error;
  }
}

export default ensureRequiredTables;

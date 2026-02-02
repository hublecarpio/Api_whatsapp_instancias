import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function ensureRequiredTables(): Promise<void> {
  console.log('[DB-INIT] Checking for required tables...');
  
  try {
    await ensureWebhookRawLogTable();
    console.log('[DB-INIT] All required tables verified/created successfully');
  } catch (error: any) {
    console.error('[DB-INIT] Error ensuring tables:', error.message);
    throw error;
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

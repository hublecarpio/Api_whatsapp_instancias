#!/usr/bin/env node
const { PrismaClient } = require('@prisma/client');

async function initExtensions() {
  const prisma = new PrismaClient();
  let hasPgcrypto = false;
  let hasUuidOssp = false;
  
  try {
    console.log('[DB-INIT] Creating required PostgreSQL extensions...');
    
    try {
      await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
      console.log('[DB-INIT] ✓ pgvector extension ready');
    } catch (err) {
      if (err.code === '42501') {
        console.log('[DB-INIT] ⚠ pgvector: permission denied (will skip vector columns)');
      } else if (err.message?.includes('already exists')) {
        console.log('[DB-INIT] ✓ pgvector extension already exists');
      } else {
        console.log('[DB-INIT] ⚠ pgvector not available:', err.message?.substring(0, 100));
      }
    }
    
    try {
      await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
      hasUuidOssp = true;
      console.log('[DB-INIT] ✓ uuid-ossp extension ready');
    } catch (err) {
      console.log('[DB-INIT] ⚠ uuid-ossp:', err.message?.substring(0, 50));
    }
    
    try {
      await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
      hasPgcrypto = true;
      console.log('[DB-INIT] ✓ pgcrypto extension ready');
    } catch (err) {
      console.log('[DB-INIT] ⚠ pgcrypto:', err.message?.substring(0, 50));
    }
    
    // FIRST: Verify core tables exist (fail fast if critical tables are missing)
    console.log('[DB-INIT] Verifying core tables...');
    const criticalTables = ['User', 'Business', 'WhatsAppInstance', 'Message', 'Contact'];
    const missingTables = [];
    
    for (const table of criticalTables) {
      try {
        const result = await prisma.$queryRawUnsafe(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = '${table}'
          );
        `);
        if (result[0]?.exists) {
          console.log(`[DB-INIT] ✓ Table ${table} exists`);
        } else {
          console.log(`[DB-INIT] ✗ Table ${table} does NOT exist`);
          missingTables.push(table);
        }
      } catch (err) {
        console.log(`[DB-INIT] ⚠ Could not verify ${table}:`, err.message?.substring(0, 50));
      }
    }
    
    if (missingTables.length > 0) {
      console.error('[DB-INIT] ═══════════════════════════════════════════════════════════════');
      console.error('[DB-INIT] CRITICAL: Missing required tables:', missingTables.join(', '));
      console.error('[DB-INIT] ');
      console.error('[DB-INIT] This indicates the database was not properly initialized.');
      console.error('[DB-INIT] Please run Prisma migrations on a database WITH pgvector extension,');
      console.error('[DB-INIT] or ensure your external database has all required tables created.');
      console.error('[DB-INIT] ═══════════════════════════════════════════════════════════════');
      process.exit(1);
    }
    
    // SECOND: Create additional tables that may be missing (only after core tables verified)
    console.log('[DB-INIT] Ensuring additional tables exist...');
    
    // Determine which UUID function to use - require pgcrypto or uuid-ossp
    let uuidDefault;
    if (hasPgcrypto) {
      uuidDefault = 'gen_random_uuid()::text';
    } else if (hasUuidOssp) {
      uuidDefault = 'uuid_generate_v4()::text';
    } else {
      console.error('[DB-INIT] ERROR: Neither pgcrypto nor uuid-ossp extension available.');
      console.error('[DB-INIT] One of these extensions is required for UUID generation.');
      process.exit(1);
    }
    
    // QuickReply table
    try {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "QuickReply" (
          id TEXT PRIMARY KEY DEFAULT ${uuidDefault},
          "businessId" TEXT NOT NULL REFERENCES "Business"(id) ON DELETE CASCADE,
          shortcut TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          "order" INTEGER NOT NULL DEFAULT 0,
          "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
          "updatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS "QuickReply_businessId_shortcut_key" ON "QuickReply"("businessId", shortcut);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "QuickReply_businessId_order_idx" ON "QuickReply"("businessId", "order");
      `);
      console.log('[DB-INIT] ✓ QuickReply table ready (UUID method: ' + (hasPgcrypto ? 'pgcrypto' : 'uuid-ossp') + ')');
    } catch (err) {
      if (err.message?.includes('already exists')) {
        console.log('[DB-INIT] ✓ QuickReply table already exists');
      } else {
        console.log('[DB-INIT] ⚠ QuickReply:', err.message?.substring(0, 100));
      }
    }
    
    console.log('[DB-INIT] Extension and table initialization complete');
    process.exit(0);
  } catch (error) {
    console.error('[DB-INIT] Fatal error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

initExtensions();

#!/usr/bin/env node
const { PrismaClient } = require('@prisma/client');

async function initExtensions() {
  const prisma = new PrismaClient();
  
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
      console.log('[DB-INIT] ✓ uuid-ossp extension ready');
    } catch (err) {
      console.log('[DB-INIT] ⚠ uuid-ossp:', err.message?.substring(0, 50));
    }
    
    console.log('[DB-INIT] Extension initialization complete');
    process.exit(0);
  } catch (error) {
    console.error('[DB-INIT] Fatal error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

initExtensions();

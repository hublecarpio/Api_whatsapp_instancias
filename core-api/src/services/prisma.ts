import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DATABASE_URL;
const poolUrl = databaseUrl ? 
  (databaseUrl.includes('?') ? 
    `${databaseUrl}&connection_limit=50&pool_timeout=30` : 
    `${databaseUrl}?connection_limit=50&pool_timeout=30`) 
  : undefined;

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: poolUrl || databaseUrl
    }
  },
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
});

export default prisma;


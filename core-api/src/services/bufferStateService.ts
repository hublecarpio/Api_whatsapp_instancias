import { getRedisConnection, isRedisAvailable } from './redis.js';
import prisma from './prisma.js';

const BUFFER_KEY_PREFIX = 'buffer:active:';
const PROCESSING_KEY_PREFIX = 'buffer:processing:';
const BUFFER_TTL = 300;
const DB_LOCK_TTL_MS = 60000;

const processingLocksDb = new Map<string, number>();

export async function isBufferActive(businessId: string, contactPhone: string): Promise<boolean> {
  if (isRedisAvailable()) {
    try {
      const redis = getRedisConnection();
      const key = `${BUFFER_KEY_PREFIX}${businessId}:${contactPhone}`;
      const exists = await redis.exists(key);
      return exists === 1;
    } catch {
      return false;
    }
  }
  return false;
}

export async function setBufferActive(businessId: string, contactPhone: string, ttlSeconds: number = BUFFER_TTL): Promise<void> {
  if (!isRedisAvailable()) {
    return;
  }
  
  try {
    const redis = getRedisConnection();
    const key = `${BUFFER_KEY_PREFIX}${businessId}:${contactPhone}`;
    await redis.setex(key, ttlSeconds, Date.now().toString());
  } catch (error) {
    console.error('[BufferState] Error setting buffer active:', error);
  }
}

export async function clearBufferActive(businessId: string, contactPhone: string): Promise<void> {
  if (!isRedisAvailable()) {
    return;
  }
  
  try {
    const redis = getRedisConnection();
    const key = `${BUFFER_KEY_PREFIX}${businessId}:${contactPhone}`;
    await redis.del(key);
  } catch (error) {
    console.error('[BufferState] Error clearing buffer active:', error);
  }
}

export async function isBufferProcessing(businessId: string, contactPhone: string): Promise<boolean> {
  if (isRedisAvailable()) {
    try {
      const redis = getRedisConnection();
      const key = `${PROCESSING_KEY_PREFIX}${businessId}:${contactPhone}`;
      const exists = await redis.exists(key);
      return exists === 1;
    } catch {
      return false;
    }
  }
  
  const lockKey = `${businessId}:${contactPhone}`;
  const lockTime = processingLocksDb.get(lockKey);
  if (lockTime && Date.now() - lockTime < DB_LOCK_TTL_MS) {
    return true;
  }
  processingLocksDb.delete(lockKey);
  return false;
}

export async function setBufferProcessing(businessId: string, contactPhone: string, ttlSeconds: number = 60): Promise<boolean> {
  if (isRedisAvailable()) {
    try {
      const redis = getRedisConnection();
      const key = `${PROCESSING_KEY_PREFIX}${businessId}:${contactPhone}`;
      const result = await redis.set(key, Date.now().toString(), 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch {
      return true;
    }
  }
  
  const lockKey = `${businessId}:${contactPhone}`;
  const existingLock = processingLocksDb.get(lockKey);
  if (existingLock && Date.now() - existingLock < DB_LOCK_TTL_MS) {
    return false;
  }
  processingLocksDb.set(lockKey, Date.now());
  return true;
}

export async function clearBufferProcessing(businessId: string, contactPhone: string): Promise<void> {
  if (isRedisAvailable()) {
    try {
      const redis = getRedisConnection();
      const key = `${PROCESSING_KEY_PREFIX}${businessId}:${contactPhone}`;
      await redis.del(key);
    } catch (error) {
      console.error('[BufferState] Error clearing buffer processing:', error);
    }
    return;
  }
  
  const lockKey = `${businessId}:${contactPhone}`;
  processingLocksDb.delete(lockKey);
}

export async function getActiveBufferCount(): Promise<number> {
  if (!isRedisAvailable()) {
    return 0;
  }
  
  try {
    const redis = getRedisConnection();
    const keys = await redis.keys(`${BUFFER_KEY_PREFIX}*`);
    return keys.length;
  } catch {
    return 0;
  }
}

export async function getProcessingBufferCount(): Promise<number> {
  if (!isRedisAvailable()) {
    return processingLocksDb.size;
  }
  
  try {
    const redis = getRedisConnection();
    const keys = await redis.keys(`${PROCESSING_KEY_PREFIX}*`);
    return keys.length;
  } catch {
    return 0;
  }
}

export function clearExpiredDbLocks(): void {
  const now = Date.now();
  for (const [key, lockTime] of processingLocksDb.entries()) {
    if (now - lockTime >= DB_LOCK_TTL_MS) {
      processingLocksDb.delete(key);
    }
  }
}

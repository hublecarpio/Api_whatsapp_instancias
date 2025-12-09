import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({ name: 'redis-client' });

let redisClient: Redis | null = null;
let isRedisAvailable = false;

export function getRedisClient(): Redis | null {
  return redisClient;
}

export function isRedisEnabled(): boolean {
  return isRedisAvailable;
}

export async function initRedis(): Promise<boolean> {
  const redisUrl = process.env.REDIS_URL;
  
  if (!redisUrl) {
    logger.info('REDIS_URL not set, using file-based session storage');
    return false;
  }

  try {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) {
          logger.warn('Redis connection failed after 3 retries, falling back to file storage');
          return null;
        }
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true
    });

    await redisClient.connect();
    await redisClient.ping();
    
    isRedisAvailable = true;
    logger.info('Redis connected successfully for session storage');
    return true;
  } catch (error: any) {
    logger.warn({ error: error.message }, 'Redis connection failed, using file-based session storage');
    redisClient = null;
    isRedisAvailable = false;
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    isRedisAvailable = false;
  }
}

import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6389';

let redisConnection: Redis | null = null;
let redisAvailable = false;

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

export function getRedisConnection(): Redis {
  if (!redisConnection) {
    redisConnection = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy: (times: number) => {
        if (times > 3) {
          redisAvailable = false;
          return null;
        }
        return Math.min(times * 500, 2000);
      }
    });

    redisConnection.on('connect', () => {
      redisAvailable = true;
      console.log('Redis connected successfully');
    });

    redisConnection.on('error', () => {
      redisAvailable = false;
    });

    redisConnection.on('close', () => {
      redisAvailable = false;
    });
  }

  return redisConnection;
}

export function createRedisConnection(): Redis {
  const conn = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy: (times: number) => {
      if (times > 3) {
        return null;
      }
      return Math.min(times * 500, 2000);
    }
  });
  
  conn.on('connect', () => {
    redisAvailable = true;
  });
  
  conn.on('error', () => {
    redisAvailable = false;
  });
  
  return conn;
}

export async function testRedisConnection(): Promise<boolean> {
  try {
    const conn = getRedisConnection();
    await conn.connect();
    await conn.ping();
    redisAvailable = true;
    console.log('Redis is available');
    return true;
  } catch (error) {
    redisAvailable = false;
    console.log('Redis is not available, using fallback mode');
    return false;
  }
}

export async function closeRedisConnection(): Promise<void> {
  if (redisConnection) {
    try {
      await redisConnection.quit();
    } catch (error) {
    }
    redisConnection = null;
    redisAvailable = false;
  }
}

export { Redis };

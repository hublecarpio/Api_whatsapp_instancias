import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Redis } from 'ioredis';

const SUPER_ADMIN_USER = process.env.SUPER_ADMIN_USER;
const SUPER_ADMIN_PASS = process.env.SUPER_ADMIN_PASS;
const SESSION_SECRET = process.env.SESSION_SECRET || 'super-admin-secret';
const REDIS_URL = process.env.REDIS_URL;
const SESSION_TTL = 12 * 60 * 60;

export interface SuperAdminRequest extends Request {
  superAdmin?: boolean;
}

interface SuperAdminSession {
  token: string;
  expiresAt: number;
}

const memoryStore = new Map<string, SuperAdminSession>();
let redisClient: Redis | null = null;
let redisConnected = false;

async function initRedis(): Promise<void> {
  if (redisClient || !REDIS_URL) return;
  
  try {
    redisClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 500,
      lazyConnect: true
    });
    
    await redisClient.connect();
    redisConnected = true;
    console.log('Super Admin sessions: Redis connected');
    
    redisClient.on('error', (err) => {
      console.log('Super Admin sessions: Redis error', err.message);
      redisConnected = false;
    });
    
    redisClient.on('close', () => {
      console.log('Super Admin sessions: Redis closed');
      redisConnected = false;
    });
    
    redisClient.on('connect', () => {
      console.log('Super Admin sessions: Redis connected');
      redisConnected = true;
    });
    
    redisClient.on('ready', () => {
      console.log('Super Admin sessions: Redis ready');
      redisConnected = true;
    });
    
    redisClient.on('reconnecting', () => {
      console.log('Super Admin sessions: Redis reconnecting...');
    });
  } catch (error) {
    console.log('Super Admin sessions: Redis not available, using memory store');
    redisClient = null;
    redisConnected = false;
  }
}

initRedis().catch(() => {});

function getSessionKey(hashedToken: string): string {
  return `superadmin:session:${hashedToken}`;
}

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function isSuperAdminConfigured(): boolean {
  return !!(SUPER_ADMIN_USER && SUPER_ADMIN_PASS);
}

export function validateSuperAdminCredentials(username: string, password: string): boolean {
  if (!SUPER_ADMIN_USER || !SUPER_ADMIN_PASS) {
    return false;
  }
  
  const userMatch = constantTimeCompare(username, SUPER_ADMIN_USER);
  const passMatch = constantTimeCompare(password, SUPER_ADMIN_PASS);
  
  return userMatch && passMatch;
}

export async function createSuperAdminSession(): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const hashedToken = hashToken(token);
  const expiresAt = Date.now() + (SESSION_TTL * 1000);
  
  const session: SuperAdminSession = {
    token: hashedToken,
    expiresAt
  };
  
  memoryStore.set(hashedToken, session);
  
  for (const [key, sess] of memoryStore.entries()) {
    if (sess.expiresAt < Date.now()) {
      memoryStore.delete(key);
    }
  }
  
  if (redisClient) {
    try {
      await redisClient.setex(
        getSessionKey(hashedToken),
        SESSION_TTL,
        JSON.stringify(session)
      );
      redisConnected = true;
    } catch (error) {
      redisConnected = false;
    }
  }
  
  return {
    token,
    expiresAt: new Date(expiresAt)
  };
}

export async function validateSuperAdminSession(token: string): Promise<boolean> {
  const hashedToken = hashToken(token);
  
  if (redisClient) {
    try {
      const data = await redisClient.get(getSessionKey(hashedToken));
      if (data) {
        const session = JSON.parse(data) as SuperAdminSession;
        if (session.expiresAt < Date.now()) {
          await redisClient.del(getSessionKey(hashedToken));
          return false;
        }
        redisConnected = true;
        return true;
      }
    } catch (error) {
      redisConnected = false;
    }
  }
  
  return validateFromMemory(hashedToken);
}

function validateFromMemory(hashedToken: string): boolean {
  const session = memoryStore.get(hashedToken);
  
  if (!session) return false;
  
  if (session.expiresAt < Date.now()) {
    memoryStore.delete(hashedToken);
    return false;
  }
  
  return true;
}

export async function revokeSuperAdminSession(token: string): Promise<void> {
  const hashedToken = hashToken(token);
  
  if (redisClient) {
    try {
      await redisClient.del(getSessionKey(hashedToken));
      redisConnected = true;
    } catch (error) {
      redisConnected = false;
    }
  }
  
  memoryStore.delete(hashedToken);
}

export async function superAdminMiddleware(req: SuperAdminRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized - No token provided' });
    return;
  }
  
  const token = authHeader.substring(7);
  
  const isValid = await validateSuperAdminSession(token);
  if (!isValid) {
    res.status(401).json({ error: 'Unauthorized - Invalid or expired token' });
    return;
  }
  
  req.superAdmin = true;
  next();
}

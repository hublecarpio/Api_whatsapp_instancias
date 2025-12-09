import { 
  AuthenticationState, 
  SignalDataTypeMap,
  initAuthCreds,
  proto,
  BufferJSON
} from '@whiskeysockets/baileys';
import { getRedisClient, isRedisEnabled } from './RedisClient';
import pino from 'pino';

const logger = pino({ name: 'redis-auth-state' });

const KEY_PREFIX = 'wa_session:';

export interface AuthStateResult {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearState: () => Promise<void>;
}

export async function useRedisAuthState(instanceId: string): Promise<AuthStateResult> {
  const redis = getRedisClient();
  
  if (!redis || !isRedisEnabled()) {
    throw new Error('Redis not available');
  }

  const keyPrefix = `${KEY_PREFIX}${instanceId}:`;

  const writeData = async (key: string, data: any): Promise<void> => {
    const serialized = JSON.stringify(data, BufferJSON.replacer);
    await redis.set(`${keyPrefix}${key}`, serialized);
  };

  const readData = async (key: string): Promise<any> => {
    const data = await redis.get(`${keyPrefix}${key}`);
    if (!data) return null;
    return JSON.parse(data, BufferJSON.reviver);
  };

  const removeData = async (key: string): Promise<void> => {
    await redis.del(`${keyPrefix}${key}`);
  };

  const clearAllData = async (): Promise<void> => {
    const keys = await redis.keys(`${keyPrefix}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    logger.info({ instanceId }, 'Cleared all session data from Redis');
  };

  let creds = await readData('creds');
  if (!creds) {
    creds = initAuthCreds();
    await writeData('creds', creds);
  }

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        
        for (const id of ids) {
          const data = await readData(`${type}-${id}`);
          if (data) {
            if (type === 'app-state-sync-key') {
              result[id] = proto.Message.AppStateSyncKeyData.fromObject(data) as unknown as SignalDataTypeMap[T];
            } else {
              result[id] = data;
            }
          }
        }
        
        return result;
      },
      set: async (data: any): Promise<void> => {
        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id];
            if (value) {
              await writeData(`${category}-${id}`, value);
            } else {
              await removeData(`${category}-${id}`);
            }
          }
        }
      }
    }
  };

  const saveCreds = async (): Promise<void> => {
    await writeData('creds', state.creds);
  };

  return {
    state,
    saveCreds,
    clearState: clearAllData
  };
}

import { 
  AuthenticationState, 
  SignalDataTypeMap,
  initAuthCreds,
  proto,
  BufferJSON
} from '@whiskeysockets/baileys';
import axios from 'axios';
import pino from 'pino';

const logger = pino({ name: 'postgres-auth-state' });

const CORE_API_URL = process.env.CORE_API_URL || 'http://localhost:3001';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'internal-secret-key';

export interface AuthStateResult {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearState: () => Promise<void>;
}

async function fetchAllSessions(instanceId: string): Promise<Record<string, string>> {
  try {
    const response = await axios.get(`${CORE_API_URL}/internal/wa/baileys-session/${instanceId}`, {
      headers: { 'x-internal-secret': INTERNAL_API_SECRET },
      timeout: 10000
    });
    return response.data.sessions || {};
  } catch (error: any) {
    logger.warn({ instanceId, error: error.message }, 'Failed to fetch sessions from PostgreSQL');
    return {};
  }
}

async function saveSession(instanceId: string, sessionKey: string, data: string): Promise<void> {
  try {
    await axios.post(`${CORE_API_URL}/internal/wa/baileys-session/${instanceId}`, {
      sessionKey,
      data
    }, {
      headers: { 'x-internal-secret': INTERNAL_API_SECRET },
      timeout: 10000
    });
  } catch (error: any) {
    logger.error({ instanceId, sessionKey, error: error.message }, 'Failed to save session to PostgreSQL');
  }
}

async function deleteSession(instanceId: string, sessionKey: string): Promise<void> {
  try {
    await axios.delete(`${CORE_API_URL}/internal/wa/baileys-session/${instanceId}/${encodeURIComponent(sessionKey)}`, {
      headers: { 'x-internal-secret': INTERNAL_API_SECRET },
      timeout: 10000
    });
  } catch (error: any) {
    logger.error({ instanceId, sessionKey, error: error.message }, 'Failed to delete session from PostgreSQL');
  }
}

async function clearAllSessions(instanceId: string): Promise<void> {
  try {
    await axios.delete(`${CORE_API_URL}/internal/wa/baileys-session/${instanceId}`, {
      headers: { 'x-internal-secret': INTERNAL_API_SECRET },
      timeout: 10000
    });
    logger.info({ instanceId }, 'Cleared all session data from PostgreSQL');
  } catch (error: any) {
    logger.error({ instanceId, error: error.message }, 'Failed to clear sessions from PostgreSQL');
  }
}

export async function usePostgresAuthState(instanceId: string): Promise<AuthStateResult> {
  const sessionCache: Map<string, any> = new Map();
  
  const allSessions = await fetchAllSessions(instanceId);
  
  for (const [key, dataStr] of Object.entries(allSessions)) {
    try {
      const parsed = JSON.parse(dataStr, BufferJSON.reviver);
      sessionCache.set(key, parsed);
    } catch (e) {
      logger.warn({ instanceId, key }, 'Failed to parse cached session data');
    }
  }
  
  let creds = sessionCache.get('creds');
  if (!creds) {
    creds = initAuthCreds();
    const serialized = JSON.stringify(creds, BufferJSON.replacer);
    await saveSession(instanceId, 'creds', serialized);
    sessionCache.set('creds', creds);
    logger.info({ instanceId }, 'Initialized new credentials');
  } else {
    logger.info({ instanceId }, 'Restored existing credentials from PostgreSQL');
  }

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        
        for (const id of ids) {
          const key = `${type}-${id}`;
          const data = sessionCache.get(key);
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
            const key = `${category}-${id}`;
            if (value) {
              sessionCache.set(key, value);
              const serialized = JSON.stringify(value, BufferJSON.replacer);
              await saveSession(instanceId, key, serialized);
            } else {
              sessionCache.delete(key);
              await deleteSession(instanceId, key);
            }
          }
        }
      }
    }
  };

  const saveCreds = async (): Promise<void> => {
    const serialized = JSON.stringify(state.creds, BufferJSON.replacer);
    await saveSession(instanceId, 'creds', serialized);
  };

  return {
    state,
    saveCreds,
    clearState: () => clearAllSessions(instanceId)
  };
}

import { WhatsAppInstance, InstanceOptions } from '../instances/WhatsAppInstance';
import { InstanceMetadata } from '../utils/types';
import logger from '../utils/logger';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { getRedisClient, isRedisEnabled } from './RedisClient';

const METADATA_FILE = path.join(process.cwd(), 'src', 'storage', 'instances.json');
const REDIS_INSTANCE_META_PREFIX = 'wa_instance_meta:';

interface CoreApiInstance {
  id: string;
  businessId: string;
  webhook: string;
  status: string;
  phoneNumber: string | null;
  lastConnection: string | null;
}

export class InstanceManager {
  private static instances: Map<string, WhatsAppInstance> = new Map();

  static normalizeWebhook(instanceId: string, webhook: string): string {
    if (!webhook) return webhook;
    
    const coreApiUrl = process.env.CORE_API_URL;
    
    if (instanceId.startsWith('biz_')) {
      const businessIdMatch = webhook.match(/\/webhook\/([a-f0-9-]+)/);
      if (businessIdMatch) {
        const businessId = businessIdMatch[1];
        
        if (coreApiUrl) {
          const normalizedUrl = coreApiUrl.replace(/\/$/, '');
          const newWebhook = `${normalizedUrl}/webhook/${businessId}`;
          
          if (newWebhook !== webhook) {
            logger.info({ 
              instanceId, 
              oldWebhook: webhook, 
              newWebhook,
              coreApiUrl 
            }, 'Normalizing webhook URL to use CORE_API_URL');
          }
          
          return newWebhook;
        }
      }
    }
    
    return webhook;
  }

  private static async fetchInstancesFromCoreApi(): Promise<InstanceMetadata[] | null> {
    const coreApiUrl = process.env.CORE_API_URL;
    const internalSecret = process.env.INTERNAL_API_SECRET || 'internal-secret-key';
    
    if (!coreApiUrl) {
      logger.warn('CORE_API_URL not set, cannot fetch instances from Core API');
      return null;
    }
    
    try {
      const response = await axios.get(`${coreApiUrl}/internal/wa/baileys-instances`, {
        headers: { 'x-internal-secret': internalSecret },
        timeout: 10000
      });
      
      const instances: CoreApiInstance[] = response.data.instances || [];
      
      logger.info({ count: instances.length }, 'Fetched instances from Core API');
      
      return instances.map(inst => ({
        id: inst.id,
        webhook: inst.webhook,
        status: inst.status,
        phoneNumber: inst.phoneNumber,
        lastConnection: inst.lastConnection ? new Date(inst.lastConnection) : null
      }));
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to fetch instances from Core API');
      return null;
    }
  }

  private static async fetchInstancesFromRedis(): Promise<InstanceMetadata[] | null> {
    if (!isRedisEnabled()) {
      return null;
    }
    
    const redis = getRedisClient();
    if (!redis) {
      return null;
    }
    
    try {
      const keys = await redis.keys(`${REDIS_INSTANCE_META_PREFIX}*`);
      if (keys.length === 0) {
        return null;
      }
      
      const instances: InstanceMetadata[] = [];
      for (const key of keys) {
        const data = await redis.get(key);
        if (data) {
          try {
            const parsed = JSON.parse(data);
            instances.push(parsed);
          } catch (e) {
            logger.warn({ key }, 'Failed to parse Redis instance metadata');
          }
        }
      }
      
      logger.info({ count: instances.length }, 'Fetched instances from Redis metadata backup');
      return instances.length > 0 ? instances : null;
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to fetch instances from Redis');
      return null;
    }
  }

  static async saveInstanceMetaToRedis(metadata: InstanceMetadata): Promise<void> {
    if (!isRedisEnabled()) {
      return;
    }
    
    const redis = getRedisClient();
    if (!redis) {
      return;
    }
    
    try {
      const key = `${REDIS_INSTANCE_META_PREFIX}${metadata.id}`;
      await redis.set(key, JSON.stringify(metadata));
      logger.debug({ instanceId: metadata.id }, 'Saved instance metadata to Redis');
    } catch (error: any) {
      logger.warn({ error: error.message, instanceId: metadata.id }, 'Failed to save instance metadata to Redis');
    }
  }

  static async deleteInstanceMetaFromRedis(instanceId: string): Promise<void> {
    if (!isRedisEnabled()) {
      return;
    }
    
    const redis = getRedisClient();
    if (!redis) {
      return;
    }
    
    try {
      const key = `${REDIS_INSTANCE_META_PREFIX}${instanceId}`;
      await redis.del(key);
      logger.debug({ instanceId }, 'Deleted instance metadata from Redis');
    } catch (error: any) {
      logger.warn({ error: error.message, instanceId }, 'Failed to delete instance metadata from Redis');
    }
  }

  static async initialize(): Promise<void> {
    logger.info({ 
      CORE_API_URL: process.env.CORE_API_URL || 'NOT SET',
      NODE_ENV: process.env.NODE_ENV || 'development'
    }, 'Initializing InstanceManager...');
    
    const storagePath = path.dirname(METADATA_FILE);
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }

    let savedMetadata = await this.fetchInstancesFromCoreApi();
    let source = 'Core API';
    
    if (!savedMetadata || savedMetadata.length === 0) {
      logger.info('No instances from Core API, trying Redis backup...');
      savedMetadata = await this.fetchInstancesFromRedis();
      source = 'Redis';
    }
    
    if (!savedMetadata || savedMetadata.length === 0) {
      logger.info('No instances from Redis, trying local JSON file...');
      savedMetadata = this.loadMetadataFromFile();
      source = 'local JSON file';
    }
    
    if (!savedMetadata || savedMetadata.length === 0) {
      logger.info('No saved instances found from any source');
      savedMetadata = [];
    } else {
      logger.info({ count: savedMetadata.length, source }, 'Loaded instances metadata');
    }

    let metadataUpdated = false;
    
    for (const metadata of savedMetadata) {
      try {
        logger.info({ instanceId: metadata.id }, 'Restoring instance...');
        
        const originalWebhook = metadata.webhook;
        const normalizedWebhook = this.normalizeWebhook(metadata.id, originalWebhook);
        
        if (normalizedWebhook !== originalWebhook) {
          metadataUpdated = true;
        }
        
        const instance = new WhatsAppInstance({
          id: metadata.id,
          webhook: normalizedWebhook,
          createdAt: metadata.createdAt ? new Date(metadata.createdAt) : undefined,
          lastConnection: metadata.lastConnection ? new Date(metadata.lastConnection) : null
        });
        this.instances.set(metadata.id, instance);
        
        await this.saveInstanceMetaToRedis({
          id: metadata.id,
          webhook: normalizedWebhook,
          status: metadata.status || 'pending',
          lastConnection: metadata.lastConnection
        });
        
        await instance.connect();
      } catch (error: any) {
        logger.error({ instanceId: metadata.id, error: error.message }, 'Failed to restore instance');
      }
    }

    if (metadataUpdated) {
      this.saveMetadata();
      logger.info('Metadata updated with corrected webhook URLs');
    }

    logger.info({ count: this.instances.size }, 'InstanceManager initialized');
  }

  private static loadMetadataFromFile(): InstanceMetadata[] {
    try {
      if (fs.existsSync(METADATA_FILE)) {
        const data = fs.readFileSync(METADATA_FILE, 'utf-8');
        return JSON.parse(data);
      }
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to load instance metadata from file');
    }
    return [];
  }

  private static loadMetadata(): InstanceMetadata[] {
    return this.loadMetadataFromFile();
  }

  private static saveMetadata(): void {
    try {
      const metadata = Array.from(this.instances.values()).map(instance => ({
        id: instance.id,
        webhook: instance.webhook,
        status: instance.status,
        createdAt: instance.createdAt,
        lastConnection: instance.lastConnection
      }));
      
      fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
      logger.debug('Instance metadata saved');
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to save instance metadata');
    }
  }

  static async createInstance(id: string, webhook: string = ''): Promise<WhatsAppInstance> {
    if (this.instances.has(id)) {
      throw new Error(`Instance with ID '${id}' already exists`);
    }

    const normalizedWebhook = this.normalizeWebhook(id, webhook);
    logger.info({ instanceId: id, originalWebhook: webhook, normalizedWebhook }, 'Creating new instance');

    const instance = new WhatsAppInstance(id, normalizedWebhook);
    this.instances.set(id, instance);
    this.saveMetadata();
    
    await this.saveInstanceMetaToRedis({
      id,
      webhook: normalizedWebhook,
      status: 'pending',
      lastConnection: null
    });

    await instance.connect();

    return instance;
  }

  static getInstance(id: string): WhatsAppInstance | undefined {
    return this.instances.get(id);
  }

  static async deleteInstance(id: string): Promise<boolean> {
    const instance = this.instances.get(id);
    
    if (!instance) {
      return false;
    }

    logger.info({ instanceId: id }, 'Deleting instance - starting cleanup');

    // Destroy first (closes socket, sets flags, calls logout)
    await instance.destroy();
    
    // Then clear session data (Redis + files)
    await instance.clearSession();
    
    // Remove from memory
    this.instances.delete(id);
    
    // Update persistent metadata
    this.saveMetadata();
    
    // Delete Redis metadata backup
    await this.deleteInstanceMetaFromRedis(id);

    logger.info({ instanceId: id }, 'Instance deleted successfully');
    return true;
  }

  static async restartInstance(id: string, newWebhook?: string): Promise<WhatsAppInstance | undefined> {
    const instance = this.instances.get(id);
    
    if (!instance) {
      return undefined;
    }

    const webhookToUse = newWebhook || instance.webhook;
    const normalizedWebhook = this.normalizeWebhook(id, webhookToUse);
    
    logger.info({ 
      instanceId: id, 
      originalWebhook: webhookToUse, 
      normalizedWebhook 
    }, 'Restarting instance');

    instance.webhook = normalizedWebhook;
    this.saveMetadata();
    
    await this.saveInstanceMetaToRedis({
      id,
      webhook: normalizedWebhook,
      status: instance.status,
      lastConnection: instance.lastConnection
    });

    await instance.close();
    await instance.connect();

    return instance;
  }

  static async resetInstance(id: string): Promise<WhatsAppInstance | undefined> {
    const instance = this.instances.get(id);
    
    if (!instance) {
      return undefined;
    }

    logger.info({ instanceId: id }, 'Resetting instance session for new WhatsApp number');

    await instance.resetSession();

    return instance;
  }

  static listInstances(): InstanceMetadata[] {
    return Array.from(this.instances.values()).map(instance => instance.getMetadata());
  }

  static getInstanceCount(): number {
    return this.instances.size;
  }

  static async shutdown(): Promise<void> {
    logger.info('Shutting down all instances...');
    
    for (const instance of this.instances.values()) {
      await instance.close();
    }
    
    this.saveMetadata();
    logger.info('All instances shut down');
  }
}

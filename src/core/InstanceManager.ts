import { WhatsAppInstance, InstanceOptions } from '../instances/WhatsAppInstance';
import { InstanceMetadata } from '../utils/types';
import logger from '../utils/logger';
import path from 'path';
import fs from 'fs';

const METADATA_FILE = path.join(process.cwd(), 'src', 'storage', 'instances.json');

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

  static async initialize(): Promise<void> {
    logger.info({ 
      CORE_API_URL: process.env.CORE_API_URL || 'NOT SET',
      NODE_ENV: process.env.NODE_ENV || 'development'
    }, 'Initializing InstanceManager...');
    
    const storagePath = path.dirname(METADATA_FILE);
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }

    const savedMetadata = this.loadMetadata();
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

  private static loadMetadata(): InstanceMetadata[] {
    try {
      if (fs.existsSync(METADATA_FILE)) {
        const data = fs.readFileSync(METADATA_FILE, 'utf-8');
        return JSON.parse(data);
      }
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to load instance metadata');
    }
    return [];
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

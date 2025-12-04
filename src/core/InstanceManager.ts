import { WhatsAppInstance, InstanceOptions } from '../instances/WhatsAppInstance';
import { InstanceMetadata } from '../utils/types';
import logger from '../utils/logger';
import path from 'path';
import fs from 'fs';

const METADATA_FILE = path.join(process.cwd(), 'src', 'storage', 'instances.json');

export class InstanceManager {
  private static instances: Map<string, WhatsAppInstance> = new Map();

  static async initialize(): Promise<void> {
    logger.info('Initializing InstanceManager...');
    
    const storagePath = path.dirname(METADATA_FILE);
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }

    const savedMetadata = this.loadMetadata();
    
    for (const metadata of savedMetadata) {
      try {
        logger.info({ instanceId: metadata.id }, 'Restoring instance...');
        const instance = new WhatsAppInstance({
          id: metadata.id,
          webhook: metadata.webhook,
          createdAt: metadata.createdAt ? new Date(metadata.createdAt) : undefined,
          lastConnection: metadata.lastConnection ? new Date(metadata.lastConnection) : null
        });
        this.instances.set(metadata.id, instance);
        
        await instance.connect();
      } catch (error: any) {
        logger.error({ instanceId: metadata.id, error: error.message }, 'Failed to restore instance');
      }
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

    logger.info({ instanceId: id, webhook }, 'Creating new instance');

    const instance = new WhatsAppInstance(id, webhook);
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

    logger.info({ instanceId: id }, 'Deleting instance');

    await instance.close();
    instance.clearSession();
    
    this.instances.delete(id);
    this.saveMetadata();

    return true;
  }

  static async restartInstance(id: string): Promise<WhatsAppInstance | undefined> {
    const instance = this.instances.get(id);
    
    if (!instance) {
      return undefined;
    }

    logger.info({ instanceId: id }, 'Restarting instance');

    await instance.close();
    await instance.connect();

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

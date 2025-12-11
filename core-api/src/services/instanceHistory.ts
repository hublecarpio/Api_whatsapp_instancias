import prisma from './prisma.js';
import { WhatsAppProvider, InstanceEventType } from '@prisma/client';

interface HistoryEvent {
  instanceId?: string | null;
  businessId: string;
  eventType: InstanceEventType;
  previousProvider?: WhatsAppProvider | null;
  newProvider?: WhatsAppProvider | null;
  previousStatus?: string | null;
  newStatus?: string | null;
  phoneNumber?: string | null;
  backendId?: string | null;
  details?: string | null;
  metadata?: Record<string, any>;
}

export async function recordInstanceEvent(event: HistoryEvent) {
  try {
    return await prisma.whatsAppInstanceHistory.create({
      data: {
        instanceId: event.instanceId,
        businessId: event.businessId,
        eventType: event.eventType,
        previousProvider: event.previousProvider,
        newProvider: event.newProvider,
        previousStatus: event.previousStatus,
        newStatus: event.newStatus,
        phoneNumber: event.phoneNumber,
        backendId: event.backendId,
        details: event.details,
        metadata: event.metadata || {}
      }
    });
  } catch (error) {
    console.error('Failed to record instance history event:', error);
    return null;
  }
}

export async function getInstanceHistory(businessId: string, limit = 50) {
  return prisma.whatsAppInstanceHistory.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    take: limit
  });
}

export async function cleanupOrphanedInstance(businessId: string, oldInstanceId: string | null, reason: string) {
  if (!oldInstanceId) return;
  
  const instance = await prisma.whatsAppInstance.findUnique({
    where: { id: oldInstanceId },
    include: { metaCredential: true }
  });
  
  if (!instance) return;
  
  await recordInstanceEvent({
    instanceId: oldInstanceId,
    businessId,
    eventType: 'DELETED',
    previousProvider: instance.provider,
    previousStatus: instance.status,
    phoneNumber: instance.phoneNumber,
    backendId: instance.instanceBackendId,
    details: `Cleaned up: ${reason}`
  });
  
  if (instance.metaCredential) {
    await prisma.metaCredential.delete({
      where: { instanceId: oldInstanceId }
    }).catch(() => {});
  }
  
  await prisma.whatsAppInstance.delete({
    where: { id: oldInstanceId }
  }).catch(() => {});
  
  console.log(`Cleaned up orphaned instance ${oldInstanceId} for business ${businessId}: ${reason}`);
}

export async function validateAndCleanInstances(businessId: string, waApiUrl: string) {
  const instances = await prisma.whatsAppInstance.findMany({
    where: { businessId },
    include: { metaCredential: true }
  });
  
  const results: { cleaned: number; valid: number; errors: string[] } = {
    cleaned: 0,
    valid: 0,
    errors: []
  };
  
  for (const instance of instances) {
    if (instance.provider === 'BAILEYS' && instance.instanceBackendId) {
      try {
        const axios = (await import('axios')).default;
        await axios.get(`${waApiUrl}/instances/${instance.instanceBackendId}/status`, {
          timeout: 5000
        });
        results.valid++;
      } catch (error: any) {
        if (error.response?.status === 404) {
          await cleanupOrphanedInstance(businessId, instance.id, 'Backend instance not found');
          results.cleaned++;
        } else {
          results.errors.push(`Instance ${instance.id}: ${error.message}`);
        }
      }
    } else if (instance.provider === 'META_CLOUD') {
      results.valid++;
    }
  }
  
  return results;
}

export function formatEventType(eventType: InstanceEventType): string {
  const labels: Record<InstanceEventType, string> = {
    CREATED: 'Instance Created',
    CONNECTED: 'Connected',
    DISCONNECTED: 'Disconnected',
    PROVIDER_CHANGED: 'Provider Changed',
    DELETED: 'Deleted',
    RECONNECTED: 'Reconnected',
    QR_GENERATED: 'QR Generated',
    SESSION_EXPIRED: 'Session Expired',
    ERROR: 'Error'
  };
  return labels[eventType] || eventType;
}

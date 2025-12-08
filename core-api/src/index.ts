import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import businessRoutes from './routes/business.js';
import productRoutes from './routes/products.js';
import policyRoutes from './routes/policies.js';
import promptRoutes from './routes/prompt.js';
import waRoutes from './routes/whatsapp.js';
import agentRoutes from './routes/agent.js';
import messageRoutes from './routes/messages.js';
import webhookRoutes from './routes/webhook.js';
import toolsRoutes from './routes/tools.js';
import mediaRoutes from './routes/media.js';
import tagsRoutes from './routes/tags.js';
import remindersRoutes from './routes/reminders.js';
import metaWebhookRoutes from './routes/metaWebhook.js';
import templatesRoutes from './routes/templates.js';
import billingRoutes from './routes/billing.js';
import superAdminRoutes from './routes/superAdmin.js';
import { testRedisConnection, closeRedisConnection, isRedisAvailable } from './services/redis.js';
import { startReminderWorker as startLegacyReminderWorker } from './services/reminderWorker.js';

dotenv.config();

let bullmqModules: {
  scheduleInactivityChecks: () => Promise<void>;
  closeQueues: () => Promise<void>;
  startReminderWorker: () => any;
  stopReminderWorker: () => Promise<void>;
  schedulePendingReminders: () => Promise<void>;
  startInactivityWorker: () => any;
  stopInactivityWorker: () => Promise<void>;
  startMessageBufferWorker: () => any;
  stopMessageBufferWorker: () => Promise<void>;
} | null = null;

const app = express();
const PORT = process.env.CORE_API_PORT || 3001;

app.use(cors());

app.use('/billing/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    name: 'Core API - WhatsApp SaaS',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      auth: '/auth/*',
      business: '/business/*',
      products: '/products/*',
      policies: '/policies/*',
      prompt: '/agent/prompt/*',
      whatsapp: '/wa/*',
      agent: '/agent/*',
      messages: '/messages/*',
      webhook: '/webhook/*',
      metaWebhook: '/webhook/meta/*',
      tags: '/tags/*'
    }
  });
});

app.use('/auth', authRoutes);
app.use('/business', businessRoutes);
app.use('/products', productRoutes);
app.use('/policies', policyRoutes);
app.use('/agent/prompt', promptRoutes);
app.use('/wa', waRoutes);
app.use('/agent', agentRoutes);
app.use('/messages', messageRoutes);
app.use('/webhook', webhookRoutes);
app.use('/agent/tools', toolsRoutes);
app.use('/media', mediaRoutes);
app.use('/tags', tagsRoutes);
app.use('/reminders', remindersRoutes);
app.use('/webhook/meta', metaWebhookRoutes);
app.use('/templates', templatesRoutes);
app.use('/billing', billingRoutes);
app.use('/super-admin', superAdminRoutes);

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

async function initializeWorkers(): Promise<void> {
  const redisAvailable = await testRedisConnection();
  
  if (redisAvailable) {
    try {
      console.log('Redis available - initializing BullMQ workers...');
      
      const [queuesIndex, reminderProc, inactivityProc, bufferProc] = await Promise.all([
        import('./services/queues/index.js'),
        import('./services/queues/reminderProcessor.js'),
        import('./services/queues/inactivityProcessor.js'),
        import('./services/queues/messageBufferProcessor.js')
      ]);
      
      queuesIndex.initializeQueues();
      
      bullmqModules = {
        scheduleInactivityChecks: queuesIndex.scheduleInactivityChecks,
        closeQueues: queuesIndex.closeQueues,
        startReminderWorker: reminderProc.startReminderWorker,
        stopReminderWorker: reminderProc.stopReminderWorker,
        schedulePendingReminders: reminderProc.schedulePendingReminders,
        startInactivityWorker: inactivityProc.startInactivityWorker,
        stopInactivityWorker: inactivityProc.stopInactivityWorker,
        startMessageBufferWorker: bufferProc.startMessageBufferWorker,
        stopMessageBufferWorker: bufferProc.stopMessageBufferWorker
      };
      
      bullmqModules.startReminderWorker();
      bullmqModules.startInactivityWorker();
      bullmqModules.startMessageBufferWorker();
      
      await bullmqModules.scheduleInactivityChecks();
      await bullmqModules.schedulePendingReminders();
      
      console.log('All BullMQ workers initialized successfully');
    } catch (error) {
      console.error('Failed to initialize BullMQ, falling back to legacy worker:', error);
      startLegacyReminderWorker();
    }
  } else {
    console.log('Redis not available - using legacy setInterval worker');
    startLegacyReminderWorker();
  }
}

async function gracefulShutdown(): Promise<void> {
  console.log('Shutting down gracefully...');
  
  try {
    if (bullmqModules && isRedisAvailable()) {
      await bullmqModules.stopReminderWorker();
      await bullmqModules.stopInactivityWorker();
      await bullmqModules.stopMessageBufferWorker();
      await bullmqModules.closeQueues();
    }
    await closeRedisConnection();
    console.log('All workers and connections closed');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`🚀 Core API running at http://0.0.0.0:${PORT}`);
  initializeWorkers();
});

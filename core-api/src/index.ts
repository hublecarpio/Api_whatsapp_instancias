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

dotenv.config();

const app = express();
const PORT = process.env.CORE_API_PORT || 3001;

app.use(cors());
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
      webhook: '/webhook/*'
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

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Core API running at http://0.0.0.0:${PORT}`);
});

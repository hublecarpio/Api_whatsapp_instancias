import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { InstanceManager } from './core/InstanceManager';
import { MediaStorage } from './core/MediaStorage';
import routes from './api/routes';
import logger from './utils/logger';

dotenv.config();

MediaStorage.initialize();

const app = express();
const PORT = parseInt(process.env.PORT || '5000', 10);

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    name: 'WhatsApp Multi-Instance API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      'POST /instances': 'Create a new WhatsApp instance',
      'GET /instances': 'List all instances',
      'GET /instances/:id/qr': 'Get QR code for instance',
      'GET /instances/:id/status': 'Get instance status',
      'POST /instances/:id/sendMessage': 'Send text message',
      'POST /instances/:id/sendImage': 'Send image with caption',
      'POST /instances/:id/sendVideo': 'Send video with caption',
      'POST /instances/:id/sendAudio': 'Send audio/voice message (PTT)',
      'POST /instances/:id/sendFile': 'Send document/file',
      'POST /instances/:id/sendSticker': 'Send sticker',
      'POST /instances/:id/sendLocation': 'Send location',
      'POST /instances/:id/sendContact': 'Send contact card',
      'POST /instances/:id/sendToLid': 'Send message to LID',
      'GET /instances/:id/lid-mappings': 'Get LID to phone mappings',
      'POST /instances/:id/lid-mappings': 'Add LID mapping',
      'POST /instances/:id/restart': 'Restart instance',
      'DELETE /instances/:id': 'Delete instance'
    }
  });
});

app.use(routes);

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error({ error: err.message, stack: err.stack }, 'Unhandled error');
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

async function start() {
  try {
    await InstanceManager.initialize();

    app.listen(PORT, '0.0.0.0', () => {
      logger.info({ port: PORT }, 'WhatsApp Multi-Instance API started');
      console.log(`\n🚀 WhatsApp API running at http://0.0.0.0:${PORT}`);
      console.log(`\nAvailable endpoints:`);
      console.log(`  POST   /instances              - Create new instance`);
      console.log(`  GET    /instances              - List all instances`);
      console.log(`  GET    /instances/:id/qr       - Get QR code`);
      console.log(`  GET    /instances/:id/status   - Get status`);
      console.log(`  POST   /instances/:id/sendMessage - Send text`);
      console.log(`  POST   /instances/:id/sendImage   - Send image`);
      console.log(`  POST   /instances/:id/sendFile    - Send file`);
      console.log(`  POST   /instances/:id/restart     - Restart instance`);
      console.log(`  DELETE /instances/:id             - Delete instance\n`);
    });

    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down...');
      await InstanceManager.shutdown();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down...');
      await InstanceManager.shutdown();
      process.exit(0);
    });

  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to start server');
    process.exit(1);
  }
}

start();

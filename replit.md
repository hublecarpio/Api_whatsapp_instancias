# WhatsApp Multi-Instance API

A scalable, multi-instance WhatsApp API built with Node.js, Express, and Baileys. This API allows you to manage multiple WhatsApp connections simultaneously, each with its own webhook configuration for receiving events.

## Overview

This project provides a REST API similar to Evolution API for managing multiple WhatsApp instances. Each instance can:
- Connect to WhatsApp via QR code scanning
- Send text messages, images, and files
- Receive incoming messages via webhooks
- Auto-reconnect on connection drops

## Project Structure

```
src/
  /api           - REST API routes and endpoints
    routes.ts    - All API endpoint handlers
  /core          - Core business logic
    InstanceManager.ts   - Manages all WhatsApp instances
    WebhookDispatcher.ts - Handles webhook delivery with retries
  /instances     - WhatsApp instance implementation
    WhatsAppInstance.ts  - Baileys wrapper class
  /storage       - Persistent storage
    /sessions    - Auth session files per instance
    instances.json - Instance metadata
  /utils         - Utility modules
    logger.ts    - Pino logger configuration
    types.ts     - TypeScript type definitions
  index.ts       - Main entry point
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | / | API info and available endpoints |
| POST | /instances | Create a new WhatsApp instance |
| GET | /instances | List all instances |
| GET | /instances/:id/qr | Get QR code for scanning |
| GET | /instances/:id/status | Get instance connection status |
| POST | /instances/:id/sendMessage | Send text message |
| POST | /instances/:id/sendImage | Send image with caption |
| POST | /instances/:id/sendFile | Send document/file |
| POST | /instances/:id/restart | Restart instance connection |
| DELETE | /instances/:id | Delete instance and session |

## Webhook Events

When a webhook URL is configured for an instance, the following events are sent:

- `connection.open` - Instance connected successfully
- `connection.close` - Connection closed (with reason)
- `qr.update` - New QR code generated
- `message.received` - Incoming message received
- `message.sent` - Message sent successfully

## Usage Examples

### Create an Instance
```bash
curl -X POST http://localhost:5000/instances \
  -H "Content-Type: application/json" \
  -d '{"instanceId": "my-instance", "webhook": "https://your-webhook.com/events"}'
```

### Get QR Code
```bash
curl http://localhost:5000/instances/my-instance/qr
```

### Send Text Message
```bash
curl -X POST http://localhost:5000/instances/my-instance/sendMessage \
  -H "Content-Type: application/json" \
  -d '{"to": "5511999999999", "message": "Hello from API!"}'
```

### Send Image
```bash
curl -X POST http://localhost:5000/instances/my-instance/sendImage \
  -H "Content-Type: application/json" \
  -d '{"to": "5511999999999", "url": "https://example.com/image.jpg", "caption": "Check this out!"}'
```

## Configuration

Environment variables:
- `PORT` - Server port (default: 5000)
- `BASE_URL` - Base URL for the API

## Development

```bash
# Run in development mode with hot reload
npm run dev

# Build TypeScript
npm run build

# Run production build
npm run serve
```

## Architecture Notes

- **InstanceManager**: Singleton that manages all WhatsApp instances in memory, with JSON file persistence for metadata
- **WhatsAppInstance**: Wraps Baileys socket with connection management, auto-reconnect, and message handling
- **WebhookDispatcher**: Handles webhook delivery with exponential backoff retry on failures
- **Sessions**: Stored in `src/storage/sessions/{instanceId}/` using Baileys multi-file auth

## Recent Changes

- Initial implementation of multi-instance WhatsApp API
- All core endpoints implemented and functional
- Webhook dispatcher with retry mechanism
- Session persistence for reconnection

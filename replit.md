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

## Docker Swarm Deployment

### Build and Push Image

```bash
# Build the image
docker build -t whatsapp-api:latest .

# Tag for your registry
docker tag whatsapp-api:latest your-registry.com/whatsapp-api:latest

# Push to registry
docker push your-registry.com/whatsapp-api:latest
```

### Deploy to Swarm

```bash
# Create .env file with your secrets
cat > .env << EOF
MINIO_ENDPOINT=https://your-minio.com
MINIO_ACCESS_KEY=your_access_key
MINIO_SECRET_KEY=your_secret_key
MINIO_BUCKET=whatsapp-media
MINIO_PUBLIC_URL=https://your-public-url.com
DOMAIN=your-domain.com
REGISTRY=your-registry.com
TAG=latest
EOF

# Deploy stack
docker stack deploy -c docker-stack.yml whatsapp --with-registry-auth

# Check status
docker service ls
docker service logs whatsapp_whatsapp-api -f
```

### Useful Commands

```bash
# Scale replicas (note: WhatsApp sessions are not shared between replicas)
docker service scale whatsapp_whatsapp-api=1

# Update service
docker service update --image your-registry.com/whatsapp-api:v2 whatsapp_whatsapp-api

# Remove stack
docker stack rm whatsapp
```

### Volume Persistence

Sessions are stored in Docker volumes:
- `whatsapp_sessions`: WhatsApp auth sessions
- `whatsapp_data`: Instance metadata

For NFS/shared storage in Swarm:
```yaml
volumes:
  whatsapp_sessions:
    driver: local
    driver_opts:
      type: nfs
      o: addr=nfs-server.local,rw
      device: ":/path/to/sessions"
```

## API Endpoints (Complete)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | / | API info and available endpoints |
| POST | /instances | Create a new WhatsApp instance |
| GET | /instances | List all instances |
| GET | /instances/:id/qr | Get QR code for scanning |
| GET | /instances/:id/status | Get instance connection status |
| POST | /instances/:id/sendMessage | Send text message |
| POST | /instances/:id/sendImage | Send image with caption |
| POST | /instances/:id/sendVideo | Send video with caption |
| POST | /instances/:id/sendAudio | Send audio/voice (PTT with waveform) |
| POST | /instances/:id/sendFile | Send document/file |
| POST | /instances/:id/sendSticker | Send sticker |
| POST | /instances/:id/sendLocation | Send location |
| POST | /instances/:id/sendContact | Send contact card |
| POST | /instances/:id/sendToLid | Send message using LID |
| GET | /instances/:id/lid-mappings | Get LID to phone mappings |
| POST | /instances/:id/lid-mappings | Add LID to phone mapping |
| POST | /instances/:id/restart | Restart instance connection |
| DELETE | /instances/:id | Delete instance and session |

## Send Examples

### Send Audio (Voice Message with Waveform)
```bash
curl -X POST http://localhost:5000/instances/my-instance/sendAudio \
  -H "Content-Type: application/json" \
  -d '{
    "to": "5511999999999",
    "url": "https://example.com/audio.ogg",
    "ptt": true
  }'
```
- `ptt: true` = Voice message with waveform (default)
- `ptt: false` = Regular audio file

### Send Video
```bash
curl -X POST http://localhost:5000/instances/my-instance/sendVideo \
  -H "Content-Type: application/json" \
  -d '{
    "to": "5511999999999",
    "url": "https://example.com/video.mp4",
    "caption": "Check this video!"
  }'
```

### Send Location
```bash
curl -X POST http://localhost:5000/instances/my-instance/sendLocation \
  -H "Content-Type: application/json" \
  -d '{
    "to": "5511999999999",
    "latitude": -23.5505,
    "longitude": -46.6333,
    "name": "São Paulo",
    "address": "São Paulo, Brazil"
  }'
```

### Send Contact
```bash
curl -X POST http://localhost:5000/instances/my-instance/sendContact \
  -H "Content-Type: application/json" \
  -d '{
    "to": "5511999999999",
    "contactName": "John Doe",
    "contactNumber": "5511888888888"
  }'
```

### Send Sticker
```bash
curl -X POST http://localhost:5000/instances/my-instance/sendSticker \
  -H "Content-Type: application/json" \
  -d '{
    "to": "5511999999999",
    "url": "https://example.com/sticker.webp"
  }'
```

## Recent Changes

- Added Docker and Docker Swarm deployment support
- Added LID (Linked ID) resolution system
- Added MinIO S3-compatible media storage
- Added sanitizePhone to prevent names in phoneNumber field
- Improved message parsing for all WhatsApp message types
- Initial implementation of multi-instance WhatsApp API
- All core endpoints implemented and functional
- Webhook dispatcher with retry mechanism
- Session persistence for reconnection

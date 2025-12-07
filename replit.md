# WhatsApp SaaS Platform

Multi-tenant WhatsApp API with AI-powered chat automation, built for integration with n8n.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (Next.js)                       │
│                    Port 5000 (public)                       │
│  - Login/Register     - Dashboard      - Chat Panel        │
│  - Business Config    - Products       - AI Prompt Editor  │
└──────────────────────────┬──────────────────────────────────┘
                           │
         ┌─────────────────┴─────────────────┐
         ▼                                   ▼
┌─────────────────────┐           ┌─────────────────────┐
│     Core API        │           │   WhatsApp API      │
│    Port 3001        │──────────▶│    Port 8080        │
│  - Auth             │           │  - Baileys          │
│  - Business CRUD    │           │  - Multi-instance   │
│  - Products         │           │  - Webhooks         │
│  - AI Pipeline      │           │  - Media (MinIO)    │
└─────────┬───────────┘           └─────────────────────┘
          │
          ▼
┌─────────────────────┐
│    PostgreSQL       │
│    (Prisma ORM)     │
└─────────────────────┘
```

## Project Structure

```
/
├── src/                      # WhatsApp API (Baileys)
│   ├── api/routes.ts         # WhatsApp endpoints
│   ├── core/
│   │   ├── InstanceManager.ts
│   │   ├── MediaStorage.ts   # MinIO integration
│   │   └── WebhookDispatcher.ts
│   └── instances/
│       └── WhatsAppInstance.ts
│
├── core-api/                 # Core API (Business Logic)
│   ├── prisma/schema.prisma  # Database schema
│   └── src/
│       ├── routes/
│       │   ├── auth.ts       # Register, Login, JWT
│       │   ├── business.ts   # Business CRUD
│       │   ├── products.ts   # Products CRUD
│       │   ├── policies.ts   # Policies CRUD
│       │   ├── prompt.ts     # AI Prompt CRUD
│       │   ├── whatsapp.ts   # WA Instance binding
│       │   ├── agent.ts      # AI Pipeline (/agent/think)
│       │   ├── messages.ts   # Message logs
│       │   └── webhook.ts    # Webhook receiver
│       ├── middleware/auth.ts
│       └── services/prisma.ts
│
├── frontend/                 # Next.js Frontend
│   ├── app/
│   │   ├── login/
│   │   ├── register/
│   │   └── dashboard/
│   │       ├── business/     # Company settings
│   │       ├── whatsapp/     # QR + connection
│   │       ├── products/     # Product catalog
│   │       ├── prompt/       # AI prompt editor
│   │       └── chat/         # Conversations
│   ├── components/
│   ├── lib/api.ts            # API client
│   └── store/                # Zustand stores
│
├── Dockerfile
├── docker-stack.yml
└── docker-compose.yml
```

## API Endpoints

### Core API (port 3001)

#### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /auth/register | Register new user |
| POST | /auth/login | Login user |
| GET | /auth/me | Get current user |

#### Business
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /business | Create business |
| GET | /business | List businesses |
| GET | /business/:id | Get business |
| PUT | /business/:id | Update business |
| PUT | /business/:id/openai | Update OpenAI config |
| PUT | /business/:id/bot-toggle | Toggle bot on/off |

#### Products
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /products | Create product |
| GET | /products?business_id=X | List products |
| PUT | /products/:id | Update product |
| DELETE | /products/:id | Delete product |

#### Policies
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /policies | Create policy |
| GET | /policies?business_id=X | Get policy |
| PUT | /policies/:id | Update policy |

#### AI Prompt
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /agent/prompt | Create/update prompt |
| GET | /agent/prompt?business_id=X | Get prompt |
| PUT | /agent/prompt/:id | Update prompt |

#### WhatsApp
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /wa/create | Create WA instance |
| GET | /wa/:businessId/status | Get status |
| GET | /wa/:businessId/qr | Get QR code |
| POST | /wa/:businessId/send | Send message |
| POST | /wa/:businessId/restart | Restart instance |
| DELETE | /wa/:businessId | Delete instance |

#### AI Pipeline
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /agent/think | Process message with AI |

#### Messages
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /messages?business_id=X | Get messages |
| GET | /messages/conversations?business_id=X | Get conversations |
| GET | /messages/conversation/:phone?business_id=X | Get conversation |

### WhatsApp API (port 8080)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /instances | Create instance |
| GET | /instances | List instances |
| GET | /instances/:id/qr | Get QR code |
| GET | /instances/:id/status | Get status |
| POST | /instances/:id/sendMessage | Send text |
| POST | /instances/:id/sendImage | Send image |
| POST | /instances/:id/sendVideo | Send video |
| POST | /instances/:id/sendAudio | Send audio/voice |
| POST | /instances/:id/sendFile | Send file |
| POST | /instances/:id/sendSticker | Send sticker |
| POST | /instances/:id/sendLocation | Send location |
| POST | /instances/:id/sendContact | Send contact |
| POST | /instances/:id/restart | Restart |
| DELETE | /instances/:id | Delete |

## AI Flow

```
1. Webhook receives message from WhatsApp API
   ↓
2. Core API /webhook/:businessId
   ↓
3. If botEnabled = true && openaiApiKey exists:
   ↓
4. POST /agent/think
   - Load business context (products, policies, prompt)
   - Build conversation history
   - Call OpenAI API
   - Send response via WhatsApp API
   - Log all messages
```

## Database Schema (Prisma)

- **User**: id, name, email, passwordHash
- **Business**: id, userId, name, description, industry, openaiApiKey, openaiModel, botEnabled
- **WhatsAppInstance**: id, businessId, instanceBackendId, status, qr, phoneNumber
- **Product**: id, businessId, title, description, price, imageUrl
- **Policy**: id, businessId, shippingPolicy, refundPolicy, brandVoice
- **AgentPrompt**: id, businessId, prompt
- **MessageLog**: id, businessId, direction, sender, recipient, message, mediaUrl

## Environment Variables

```bash
# Database
DATABASE_URL=postgresql://...

# Core API
CORE_API_PORT=3001
CORE_API_URL=http://localhost:3001

# WhatsApp API
WA_PORT=8080
WA_API_URL=http://localhost:8080

# Auth
SESSION_SECRET=your-secret

# MinIO
MINIO_ENDPOINT=https://...
MINIO_ACCESS_KEY=...
MINIO_SECRET_KEY=...
MINIO_BUCKET=...
MINIO_PUBLIC_URL=https://...
```

## Development

```bash
# All services run simultaneously via workflows:
# - Frontend: npm run dev (port 5000)
# - Core API: npm run dev (port 3001)
# - WhatsApp API: npm run dev (port 8080)
```

## Docker Deployment

```bash
# Build
docker build -t whatsapp-saas .

# Docker Swarm
docker stack deploy -c docker-stack.yml whatsapp-saas
```

## Recent Changes

- Added complete SaaS platform with Core API
- Created Next.js frontend with dashboard
- Implemented user authentication (JWT)
- Added business management with OpenAI configuration
- Created products and policies CRUD
- Built AI pipeline with OpenAI integration
- Added chat panel with real-time conversations
- Configured multi-service architecture

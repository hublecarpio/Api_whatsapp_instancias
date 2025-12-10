# WhatsApp SaaS Platform

## Overview
This project is a multi-tenant SaaS platform providing a WhatsApp API solution with integrated AI-powered chat automation. It's designed for businesses to manage WhatsApp communications, automate responses using AI, and integrate with external tools like n8n. The platform aims to streamline customer interactions, enhance business efficiency through automated support, and offer a robust, scalable communication channel.

## User Preferences
I prefer clear and concise explanations.
I value iterative development and expect to be consulted on major architectural changes.
Please provide detailed explanations for complex logic or decisions.
I prefer that the agent focuses on completing the current task rather than asking too many clarifying questions unless absolutely necessary for task completion.
Do not make changes to the `docker-stack-external-db.yml` file.

## System Architecture
The platform follows a microservices-like architecture comprising three main components:

1.  **Frontend (Next.js)**: A public-facing web application on Port 5000 for user authentication (Login/Register), business configuration, product management, AI prompt editing, and a chat panel for managing conversations. It uses Zustand for state management.
2.  **Core API (Node.js/Express)**: The central business logic layer on Port 3001, handling authentication (JWT), CRUD operations for businesses, products, policies, and AI prompts. It orchestrates the AI pipeline, binds WhatsApp instances, manages message logging, and processes webhooks. Prisma ORM is used for database interactions.
3.  **WhatsApp API (Node.js/Baileys & Meta Cloud API)**: This service on Port 8080 manages multi-instance WhatsApp connections using Baileys or integrates with Meta Cloud API. It handles message sending/receiving, QR code generation, and webhook dispatching. MinIO is used for media storage.

**UI/UX Decisions**: The frontend features a modern, WhatsApp-style chat panel with message bubbles, read receipts, and support for various media types. It includes a collapsible sidebar and an AI Agent configuration panel.

**Technical Implementations**:
*   **AI Pipeline**: Processes incoming WhatsApp messages via a webhook, leverages business context (products, policies, prompts), conversation history, and OpenAI API to generate AI responses, which are then sent back via the WhatsApp API.
*   **Multi-Provider WhatsApp**: Supports both Baileys for direct WhatsApp Web integration and Meta Cloud API for official business accounts, offering flexibility in WhatsApp connectivity.
*   **Meta Cloud API Integration**: 
    - Provider selection UI with modal for choosing between Baileys (QR) or Meta Cloud (credentials form)
    - Meta webhook routes (`/webhook/meta/:instanceId`) for receiving incoming messages
    - MetaCloudService for sending text, images, videos, audio, documents, and approved templates
    - 24-hour conversation window tracking - after 24h of client inactivity, only templates can be sent
    - Message Templates page (`/dashboard/templates`) for managing Meta-approved templates
    - Template sync from Meta Graph API
*   **24-Hour Conversation Window**:
    - Endpoint `/messages/conversation/:phone/window-status` checks window status
    - Chat panel shows visual indicator of time remaining or template requirement
    - Reminder worker automatically uses templates when window is closed
*   **AI Agent Tools**: Allows the AI agent to call external POST endpoints with dynamic parameter interpolation based on conversation context.
*   **Message Buffering**: Accumulates messages for a configurable duration before triggering an AI response.
*   **Multimodal Response Handling**: Automatically detects and sends various media types (images, videos, files) and handles S3 shortcodes or full URLs.
*   **Reminder/Follow-up System**: Background worker for automatic inactivity detection and scheduling AI-generated follow-up messages or manual reminders. For Meta Cloud instances, uses approved templates when 24h window expires.
*   **Redis + BullMQ Queue System**:
    - Redis service `efficore_redis` on port 6389 (custom port to avoid conflicts)
    - BullMQ queues for: reminders, message buffering, WhatsApp incoming messages, inactivity checks
    - Automatic fallback to legacy setInterval worker when Redis is unavailable (development mode)
    - Retry logic with exponential backoff for failed jobs
    - Graceful shutdown with proper cleanup of workers and connections
    - Environment variable: `REDIS_URL=redis://efficore_redis:6389`
*   **Stripe Billing Integration**:
    - 7-day free trial with credit card required upfront
    - Weekly recurring payment of $50 USD
    - Stripe Checkout for subscription creation
    - Webhook handler for payment events (success, failure, cancellation)
    - Automatic account suspension on payment failure
    - Billing page showing subscription status, next payment, cancel/reactivate options
    - Subscription status indicator in dashboard sidebar
*   **Email Verification System**:
    - Users must verify email before creating WhatsApp instances
    - Server-side enforcement via `requireEmailVerified` middleware on `/wa/create` and `/wa/create-meta` endpoints
    - Frontend UI: EmailVerificationBanner in dashboard, verify-email page with token validation
    - SMTP integration via Nodemailer with branded dark-theme HTML template matching EfficoreChat design
    - Verification token with 24-hour expiry, hashed before storage
    - Rate-limited resend functionality (2 minutes throttle)
    - Access tiers: Without email verification - CRM/Chat/Instances blocked; After verification - full access to free tier features
*   **Robust Deployment**: Dockerized services with improved health checks, database wait logic, and environment variable support for flexible port configuration.
*   **Super Admin Panel**:
    - Centralized administration panel at `/super-admin` for platform monitoring
    - Environment-based authentication using `SUPER_ADMIN_USER` and `SUPER_ADMIN_PASS`
    - Separate session management with Redis-backed tokens
    - Dashboard tabs: Overview, Users, Businesses, WhatsApp, Token Usage, Messages, Billing, System
    - Real-time platform metrics: total users, active instances, message counts
    - Token usage tracking per business and per feature (AI agent, reminders, etc.)
    - Billing overview with subscription status and trial expiration warnings
    - System health monitoring: database, OpenAI, Stripe, Redis connectivity
    - **WhatsApp Instance Management**:
        - Lists all active instances from WhatsApp API (not just database)
        - Enriches instances with business/user info from database
        - Identifies orphaned instances (active in API but not in DB)
        - Actions: Restart connection, Disconnect (API only), Delete (API + DB)
        - Helps resolve connection conflicts (error 440) by allowing cleanup
        - Proxy endpoints: `/api/super-admin/wa-instances`, DELETE/POST for management
*   **Centralized OpenAI API Management**:
    - Single platform-wide OpenAI API key configured via `OPENAI_API_KEY` environment variable
    - Model selection via `OPENAI_MODEL` (defaults to gpt-4o-mini)
    - Token usage automatically logged to `TokenUsage` table for each API call
    - Cost tracking based on prompt/completion tokens
    - Usage breakdown by business and by feature
*   **Per-Contact Bot Control**:
    - Two-level bot control: global toggle (AI Agent dashboard) and per-contact toggle (chat panel)
    - `ContactSettings` model stores `botDisabled` flag per businessId + contactPhone combination
    - Endpoints: `GET /tags/contact/:phone/bot-status` and `PATCH /tags/contact/:phone/bot-toggle`
    - Per-contact disabled takes precedence over global enabled
    - Chat panel displays contact-level bot status with toggle button
    - Visual indicators: green when active, red when contact-disabled, gray when global-disabled
*   **Dynamic Prompt Variables**:
    - Variables: `{{now}}`, `{{date}}`, `{{time}}`, `{{day_of_week}}`, `{{day}}`, `{{month}}`, `{{year}}`, `{{hour}}`, `{{minute}}`
    - Spanish locale formatting (e.g., "Lunes 9 de Diciembre 2024, 20:30")
    - Configurable timezone per business (stored in Business model, default: America/Lima)
    - Timezone selector in Business settings page with common Latin American/US/European options
    - Variables replaced before sending prompt to OpenAI
    - Service: `core-api/src/services/promptVariables.ts` using Intl.DateTimeFormat
*   **Timezone-Aware Reminder System**:
    - Reminder worker respects business timezone for allowed hours (allowedStartHour, allowedEndHour)
    - Weekend detection uses business timezone instead of server time
    - Runs every 60 seconds via setInterval (fallback mode when Redis unavailable)
    - Detects client inactivity and schedules follow-up reminders automatically
*   **Agent V2 - Advanced AI Processing (Python/LangGraph)**:
    - Separate Python microservice (`agent-v2/`) with FastAPI and LangGraph
    - Toggle between V1 (direct OpenAI) and V2 (LangGraph) per business
    - Database field: `Business.agentVersion` (default: 'v1')
    - Core API proxy: routes to `AGENT_V2_URL` when `agentVersion='v2'`
    - Pydantic schemas for structured input/output validation
    - Environment: `AGENT_V2_URL=http://localhost:5001` (dev) or `http://agent-v2:5001` (Swarm)
    - Docker: Separate image `agent-v2:latest` on port 5001
    - UI: Toggle in AI Agent dashboard (`/dashboard/prompt`) to switch versions
*   **Production-Grade Baileys Stability**:
    - Redis session state with automatic file-based fallback
    - Watchdog heartbeat (90s intervals) detects zombie connections
    - Rate limiting: 25 messages/minute per instance
    - Anti-burst protection: 30s cooldown after connection before sending
    - Exponential backoff: 1-30s delays for reconnection attempts
    - StatusCode handling: 410 triggers QR regeneration, 401 invalidates session
    - Post-connect resync and message update handler
    - Read receipts with sendReceipt()
*   **Gemini Multimedia Processing**:
    - Google Gemini API integration for processing incoming media
    - Audio transcription: converts voice messages to text before sending to AI orchestrator
    - Image analysis: describes images and stickers to provide context
    - Video analysis: describes video content for AI understanding
    - Service: `core-api/src/services/gemini.ts`
    - Environment: `GEMINI_API_KEY` and optionally `GEMINI_MODEL` (defaults to gemini-2.0-flash)
    - Integrated with messageIngest to enrich messages before AI processing
*   **Meta Cloud Media Upload Flow**:
    - Downloads media from MinIO/S3, uploads to Meta's media API, uses media_id for sending
    - Resolves issue with Meta Cloud not accessing private storage URLs
    - Audio converted to OGG Opus format (48kHz, mono, voip application) for WhatsApp compatibility
*   **Customizable Contact Data Extraction**:
    - Businesses can define custom fields to extract from conversations (name, address, email, etc.)
    - Prisma models: `ExtractionField` (field definitions) and `ContactExtractedData` (extracted values)
    - Default fields: nombre, email, direccion, ciudad, telefono_alternativo
    - UI: "Extraccion" tab in Orders page (`/dashboard/orders`)
    - Endpoints: `/extraction/fields/:businessId` for CRUD, `/extraction/contact/:businessId/:phone` for data
    - Service: `core-api/src/services/contactExtraction.ts` integrates with Gemini AI
    - Multi-tenant security: All operations verify field ownership by businessId
*   **Intelligent Product Search**:
    - Fuzzy matching using Levenshtein distance algorithm
    - Finds products even with typos or name variations (>70% similarity threshold)
    - Service: `core-api/src/services/productSearch.ts`
    - AI agent prompt updated to trust fuzzy search results

**System Design Choices**:
*   **Database**: PostgreSQL with Prisma ORM for type-safe database access and schema management.
*   **Scalability**: Multi-instance design for WhatsApp API allows scaling connections independently.
*   **Security**: JWT-based authentication for securing API endpoints.
*   **Observability**: Message logging and tool execution history for monitoring AI agent performance.

## Environment Configuration (Replit vs Docker Swarm)

The application uses environment variables to handle different deployment environments:

### Replit (Development)
```
PORT=5000
CORE_API_PORT=3001
CORE_API_URL=http://localhost:3001
WA_PORT=8080
WA_API_URL=http://localhost:8080
```

### Docker Swarm (Production)
```yaml
# Frontend service
NEXT_PUBLIC_API_URL: http://core-api:4001

# Core API service
WA_API_URL: http://whatsapp-api:4080

# WhatsApp API service
WA_PORT: 4080
CORE_API_URL: http://core-api:4001
```

**Important**: Never connect the same WhatsApp number in both Replit and production simultaneously - this causes connection conflicts (error 440: Stream Errored).

## External Dependencies

*   **PostgreSQL**: Primary database for all application data, managed via Prisma ORM.
*   **MinIO**: Object storage service used for media management (images, videos, files) associated with WhatsApp messages.
*   **OpenAI API**: Used by the AI pipeline for generating automated chat responses and leveraging advanced language models.
*   **Baileys**: A Node.js library for interacting with the WhatsApp Web API, used for direct WhatsApp integration.
*   **Meta Cloud API (WhatsApp Business Platform)**: Integrated for official WhatsApp Business Account interactions.
*   **n8n**: The platform is built for integration with n8n for workflow automation.
*   **Docker / Docker Swarm**: For containerization and orchestration of all services.
*   **Redis**: Message queue backend using BullMQ for robust job processing, reminders, and message buffering. Service name: `efficore_redis`, port: `6389`, volume: `efficore_redis_data`.
# WhatsApp SaaS Platform

## Overview
This project is a multi-tenant SaaS platform providing a WhatsApp API solution with integrated AI-powered chat automation. It enables businesses to manage WhatsApp communications, automate responses using AI, and integrate with external tools. The platform aims to streamline customer interactions, enhance business efficiency, and provide a robust, scalable communication channel, leveraging AI to transform customer service and engagement.

## User Preferences
I prefer clear and concise explanations.
I value iterative development and expect to be consulted on major architectural changes.
Please provide detailed explanations for complex logic or decisions.
I prefer that the agent focuses on completing the current task rather than asking too many clarifying questions unless absolutely necessary for task completion.
Do not make changes to the `docker-stack-external-db.yml` file.

## System Architecture
The platform employs a microservices-like architecture with a **Frontend (Next.js)**, a **Core API (Node.js/Express)**, and a **WhatsApp API (Node.js/Baileys & Meta Cloud API)**.

**UI/UX Decisions**: Features a modern, WhatsApp-style chat panel, collapsible sidebar, AI Agent configuration, and accordion-style UI. Includes a `HubleFooter` component for branding. Super Admin can enable a Glassmorphism UI mode and configure white-label branding (app name, tagline, logo, favicon, colors).

**Technical Implementations**:
*   **AI Pipeline**: Processes WhatsApp messages using business context, conversation history, and OpenAI API.
*   **Multi-Provider WhatsApp**: Supports three connection modes:
    *   **Baileys** (WhatsApp Web): QR-based connection for personal/business WhatsApp numbers.
    *   **Meta Cloud API**: Official WABA with full API control and template messages.
    *   **Meta Coexistence**: Connect existing WhatsApp Business App numbers via Embedded Signup + Coexistence flow. Allows clients to keep using their WhatsApp Business App while also sending/receiving via Cloud API.
*   **AI Agent System**:
    *   **Agent V2 (Python/LangGraph)**: Advanced multi-agent system with a 3-brain architecture (Vendor → Observer → Refiner), 5 executable tools, Redis-backed memory, OpenAI embeddings for semantic product search, and dynamic learning. Features a state-governed architecture (`CommercialState`, `EtapaComercial`) and ReAct retry mechanism.
    *   **Custom Tools Support**: Allows AI agents to call external POST endpoints with dynamic parameter interpolation and native OpenAI function calling for both Agent V1 (Node.js) and Agent V2 (Python).
*   **Reminder/Follow-up System**: Event-driven scheduling of follow-ups via BullMQ (when Redis available) or polling, with distributed locking, exponential backoff, and AI-enriched message generation. Supports Meta Cloud Template Configuration with variable mapping and validation.
*   **Redis + BullMQ Queue System**: Manages reminders, message buffering, WhatsApp messages, and AI responses with retry logic.
*   **Stripe Billing Integration**: Implements tiered pricing (BASIC, PRO), trial periods, recurring payments, webhooks, account suspension, and on-demand token credit purchases. Supports subscription freezing.
*   **Email Verification System**: Requires email verification for WhatsApp instance creation.
*   **Robust Deployment**: Dockerized services with improved health checks.
*   **Super Admin Panel**: Centralized administration for command center, event logging, user/business management, WhatsApp instance control, token usage, billing, referral codes, and global UI/branding customization.
*   **Centralized OpenAI API Management**: Uses a single platform-wide key, allows model selection, logs token usage, and optimizes tokens. Dynamic AI model configuration is available.
*   **Per-Contact Bot Control**: Global and per-contact toggles for bot functionality.
*   **Production-Grade Baileys Stability**: Redis session state, watchdog, rate limiting, error handling, and Docker restart persistence.
*   **Gemini Multimedia Processing**: Integrates Google Gemini API for audio transcription, image, and video analysis.
*   **Customizable Contact Data Extraction**: Businesses configure custom fields for AI extraction from conversations, stored with confidence scores and source tracking. Extracted data is injected into agent context.
*   **Automatic Lead Stage Updates**: Lead stages are updated after each interaction cycle using Gemini, providing context for AI agents.
*   **Intelligent Product Search**: Fuzzy matching with typo tolerance.
*   **Provider-Separated Token Usage Tracking**: Tracks token usage by provider and feature.
*   **Payment Mode Control**: Toggle for Stripe payment link vs. voucher-based order flow.
*   **Dual Business Objectives (SALES/APPOINTMENTS)**: Businesses can toggle between e-commerce and service modes, influencing UI and AI agent behavior.
*   **Appointment Scheduling System**: Full CRUD, status tracking, double-booking prevention, automatic reminders, and AI tools for scheduling. Enhanced with **Google Calendar integration** supporting automatic Google Meet link generation (`conferenceDataVersion=1`, `hangoutsMeet`), guest email invitations with calendar notifications, custom event titles, and meeting URL persistence. AI agent tool (`agendar_cita`) can request guest email and create Meet links during conversation.
*   **Business Availability Configuration**: Configurable working hours and blocked dates.
*   **Delivery Tracking**: Orders include `DELIVERED` status, agent assignment, and quick actions.
*   **Agent Files Library (V1)**: Upload documents/images for contextual AI use via the "enviar_archivo" AI tool.
*   **Contact CRM System**: Dedicated Contact table with automatic creation, tags, notes, email, message counts, and full CRUD API.
*   **Enhanced Mass Broadcast System**: Supports file upload (MinIO), CSV import, variable interpolation, deduplication, Meta template preservation, and WhatsApp group import for Baileys instances.
*   **Referral Code System**: Marketing tracking via unique URLs, with CRUD for codes and usage statistics. Extended with an affiliate program.
*   **Advisor/Agent System**: Role-based access control for team members with invitation workflow and contact assignment. Round-robin lead auto-assignment.
*   **Multi-Role User System**: Users can simultaneously own their own businesses and serve as advisors for other businesses. The `UserBusinessRole` table tracks user-business relationships with roles (OWNER/ADVISOR). Login returns all accessible business contexts, and a ContextSwitcher component in the sidebar allows users to switch between businesses. Existing users can be invited as advisors without email conflicts. Legacy advisors can be migrated via the `/auth/migrate-advisors` endpoint (Super Admin only).
*   **Distributed Buffer State Management**: Buffer processing state in Redis with distributed locking, BullMQ for expired buffer processing, and atomic buffer claiming with DB locking.
*   **Guided Onboarding with Effi**: Fullscreen 3-step onboarding wizard for new users (QR connection, product setup, AI agent prompt).
*   **Delegated Agent System**: Super Admin can assign a user as a "delegated agent" to track and follow up with platform users, who are synced as contacts.
*   **Phone Verification System**: Users verify phone numbers via WhatsApp OTP through the Super Admin's delegated agent instance.
*   **Multi-Instance WhatsApp Support**: PRO/Enterprise users can connect multiple WhatsApp numbers. Each instance has independent configuration (prompts, follow-ups, webhooks) and per-instance API credentials.

**System Design Choices**:
*   **Database**: PostgreSQL with Prisma ORM.
*   **Scalability**: Horizontally scalable, stateless Core API; state managed in Redis.
*   **Security**: JWT-based authentication.
*   **Observability**: Message logging and tool execution history.

## External Dependencies

*   **PostgreSQL**: Primary database.
*   **MinIO**: Object storage service.
*   **OpenAI API**: For AI-powered chat responses and language models.
*   **Baileys**: WhatsApp Web API integration.
*   **Meta Cloud API (WhatsApp Business Platform)**: For official WhatsApp Business Accounts.
*   **n8n**: For workflow automation integration.
*   **Docker / Docker Swarm**: For containerization and orchestration.
*   **Redis**: Message queue backend for BullMQ.
*   **Stripe**: Payment gateway for billing.
*   **Nodemailer**: For email sending.
*   **Google Gemini API**: For multimedia processing.

## Environment Variables for Meta Coexistence

To enable Meta Coexistence (Embedded Signup + Coexistence flow), configure these environment variables:

| Variable | Description | Required |
|----------|-------------|----------|
| `META_APP_ID` | Meta App ID from Facebook Developer Console | Yes |
| `META_APP_SECRET` | Meta App Secret from Facebook Developer Console | Yes |
| `META_COEXIST_REDIRECT_URI` | OAuth callback URL (default: `{API_URL}/auth/meta-coexist/callback`) | No |
| `META_WEBHOOK_VERIFY_TOKEN` | Token for Meta webhook verification | No |
| `FRONTEND_URL` | Frontend URL for OAuth callback redirects in production (e.g., `https://app.efficore.es`) | Yes (production) |

### Meta Coexistence API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/meta-coexist/start` | GET | Initiate OAuth flow for Meta Coexistence |
| `/auth/meta-coexist/callback` | GET | OAuth callback handler |
| `/auth/meta-coexist/setup` | POST | Complete setup with selected phone number |
| `/auth/meta-coexist/activate/:instanceId` | POST | Activate coexistence mode |
| `/auth/meta-coexist/status/:instanceId` | GET | Check coexistence status |
| `/auth/meta-coexist/wabas` | GET | List available WABAs |
| `/auth/meta-coexist/phone-numbers` | GET | List phone numbers in a WABA |
| `/auth/meta-coexist/disconnect/:instanceId` | POST | Disconnect Meta Coexistence |

## External API - Order Management (N8N Integration)

The platform provides a complete REST API for order management accessible via API key authentication. All endpoints require a PRO subscription and use Bearer token authentication.

### Authentication
```
Authorization: Bearer efk_your_api_key_here
```

### Order States Flow
```
AWAITING_VOUCHER → PAID → PROCESSING → SHIPPED → DELIVERED
                     ↘                              ↗
                       → CANCELLED / REFUNDED
```

### Order API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/orders` | GET | List all orders (supports `status` and `limit` query params) |
| `/api/v1/orders/:orderId` | GET | Get a specific order with items |
| `/api/v1/orders` | POST | Create a new order (purchase intent) |
| `/api/v1/orders/:orderId/status` | PATCH | Change order status |
| `/api/v1/orders/:orderId/confirm` | POST | Confirm payment after voucher received |
| `/api/v1/orders/:orderId/voucher` | POST | Attach voucher image to order |
| `/api/v1/orders/:orderId` | DELETE | Delete order (only AWAITING_VOUCHER or CANCELLED) |

### Create Order Request (POST /api/v1/orders)
```json
{
  "contactPhone": "51999888777",
  "contactName": "Juan Pérez",
  "items": [
    { "productId": "uuid-here", "quantity": 2 },
    { "productTitle": "Custom Item", "unitPrice": 50.00, "quantity": 1 }
  ],
  "shippingAddress": "Av. Example 123",
  "shippingCity": "Lima",
  "shippingCountry": "Peru",
  "notes": "Optional notes"
}
```

### Update Order Status Request (PATCH /api/v1/orders/:orderId/status)
```json
{
  "status": "SHIPPED",
  "notes": "Tracking: ABC123",
  "deliveryAgentName": "Carlos Delivery"
}
```

### State Transition Rules
The API enforces the following valid state transitions:

| From Status | Allowed Next Statuses |
|-------------|----------------------|
| `AWAITING_VOUCHER` | `PAID`, `CANCELLED` |
| `PAID` | `PROCESSING`, `CANCELLED`, `REFUNDED` |
| `PROCESSING` | `SHIPPED`, `CANCELLED`, `REFUNDED` |
| `SHIPPED` | `DELIVERED`, `CANCELLED`, `REFUNDED` |
| `DELIVERED` | `REFUNDED` |
| `CANCELLED` | (final state) |
| `REFUNDED` | (final state) |

Invalid transitions will return a 400 error with details about allowed transitions.

### Attach Voucher Request (POST /api/v1/orders/:orderId/voucher)
```json
{
  "voucherImageUrl": "https://minio.example.com/voucher.jpg",
  "autoConfirm": true
}
```
Set `autoConfirm: true` to automatically mark as PAID when attaching voucher.

## AI Agent Order Tools

The AI agent automatically uses order tools based on business configuration:

### Tool Selection Logic
- **`crear_enlace_pago`**: Used when `paymentLinkEnabled=true` (Super Admin enabled Stripe). Creates Stripe payment links.
- **`crear_pedido_voucher`**: Used when `paymentLinkEnabled=false` (default). Creates orders with `AWAITING_VOUCHER` status.

### When Agent Creates Orders
The agent decides to create an order when:
1. Customer confirms purchase intent (e.g., "Sí, quiero comprarlo")
2. Agent has collected required data: product ID, customer name, shipping address
3. Business is in SALES mode (not APPOINTMENTS)

### Agent Order Context
The agent receives context about pending orders in its system prompt:
- If customer has a pending order awaiting voucher, agent reminds them to send payment proof
- If voucher was received, agent confirms and thanks customer
- Validated voucher details (bank, amount, code) are injected into conversation

### Voucher Validation Flow
1. Customer sends image via WhatsApp
2. Gemini Vision analyzes the image for payment proof
3. If valid voucher detected, it's automatically attached to pending order
4. Agent receives context: "COMPROBANTE DE PAGO RECIBIDO Y VALIDADO"
5. Admin can confirm payment via dashboard or API
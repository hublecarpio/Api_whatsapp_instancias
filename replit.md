# WhatsApp SaaS Platform

## Overview
This project is a multi-tenant SaaS platform that provides a WhatsApp API solution with integrated AI-powered chat automation. Its primary purpose is to enable businesses to manage WhatsApp communications, automate responses using AI, and integrate with external tools like n8n. The platform aims to streamline customer interactions, enhance business efficiency through automated support, and offer a robust, scalable communication channel. The business vision is to provide a comprehensive communication tool that leverages AI to transform customer service and engagement for various industries, offering significant market potential in the growing SaaS and communication automation sectors.

## User Preferences
I prefer clear and concise explanations.
I value iterative development and expect to be consulted on major architectural changes.
Please provide detailed explanations for complex logic or decisions.
I prefer that the agent focuses on completing the current task rather than asking too many clarifying questions unless absolutely necessary for task completion.
Do not make changes to the `docker-stack-external-db.yml` file.

## System Architecture
The platform employs a microservices-like architecture consisting of a **Frontend (Next.js)**, a **Core API (Node.js/Express)**, and a **WhatsApp API (Node.js/Baileys & Meta Cloud API)**.

**UI/UX Decisions**: The frontend features a modern, WhatsApp-style chat panel with message bubbles, read receipts, and support for various media types. It includes a collapsible sidebar, an AI Agent configuration panel, and an accordion-style UI for displaying orders.

**Technical Implementations**:
*   **AI Pipeline**: Processes incoming WhatsApp messages using business context, conversation history, and OpenAI API to generate and send AI responses.
*   **Multi-Provider WhatsApp**: Supports both Baileys for direct WhatsApp Web integration and Meta Cloud API for official business accounts, offering flexible connectivity.
*   **Meta Cloud API Integration**: Includes provider selection, webhook routes, media sending capabilities, and management of Meta-approved message templates with 24-hour conversation window tracking.
*   **24-Hour Conversation Window Management**: Tracks conversation window status, provides UI indicators, and uses reminder workers to send templates when the window closes.
*   **AI Agent Tools**: Allows AI agents to call external POST endpoints with dynamic parameter interpolation.
*   **Message Buffering**: Accumulates messages for a configurable duration before triggering AI responses.
*   **Multimodal Response Handling**: Automatically detects and sends various media types and handles S3 shortcodes or full URLs.
*   **Reminder/Follow-up System**: A background worker for inactivity detection and scheduling AI-generated follow-ups or manual reminders, respecting business timezones.
*   **Redis + BullMQ Queue System**: Uses Redis and BullMQ for robust job processing, including reminders, message buffering, WhatsApp message handling, and AI response processing, with automatic fallback and retry logic.
*   **BullMQ AI Response Queue**: High-concurrency AI processing queue (configurable via `WORKER_CONCURRENCY`, default 40) that parallelizes OpenAI API calls. Supports OpenAI Tier 4 rate limits (10,000 req/min) by processing multiple AI requests simultaneously. Includes graceful fallback to synchronous processing when Redis is unavailable. Optimized with 120s lock duration and stalled job handling for stability. Monitor via `/agent/queue-stats` endpoint.
*   **Stripe Billing Integration**: Implements a 7-day free trial, weekly recurring payments via Stripe Checkout, webhook handling for payment events, and automatic account suspension.
*   **Email Verification System**: Requires email verification for users to create WhatsApp instances, with server-side enforcement, a dedicated UI, and SMTP integration.
*   **Robust Deployment**: Dockerized services with improved health checks, database wait logic, and environment variable support.
*   **Super Admin Panel**: A centralized administration panel featuring Command Center (unified dashboard with real-time system health, key metrics, and activity feed), DevConsole (real-time event log viewer with auto-refresh, severity filtering, and detailed event inspection), plus user/business management, WhatsApp instance control, token usage tracking, billing overview, and referral code management.
*   **System Event Logging**: Centralized eventLogger service tracks all platform events with severity levels (DEBUG, INFO, WARNING, ERROR, CRITICAL), sources, and structured metadata for comprehensive observability.
*   **Centralized OpenAI API Management**: Uses a single platform-wide OpenAI API key, allows model selection, and logs token usage for cost tracking.
*   **Per-Contact Bot Control**: Provides two-level bot control (global and per-contact) with a `botDisabled` flag, UI toggles, and visual indicators.
*   **Dynamic Prompt Variables**: Supports dynamic variables like `{{now}}` with configurable timezones for businesses, replaced before sending prompts to OpenAI.
*   **Agent V2 - Multi-Agent AI System (Python/LangGraph)**: An advanced Python microservice with 3-brain architecture (Vendor → Observer → Refiner). Features 5 executable tools (search_product, payment, followup, media, crm), Redis-backed memory persistence, OpenAI embeddings for semantic product search with Redis-based embedding cache (7-day TTL), and dynamic learning system that saves rules per business. Runs with gunicorn multi-worker (configurable via `WORKERS` env, default 4) for horizontal scaling. Restricted to Pro tier users.
*   **Production-Grade Baileys Stability**: Features Redis session state, watchdog heartbeat, rate limiting, anti-burst protection, exponential backoff, and robust error handling.
*   **Gemini Multimedia Processing**: Integrates Google Gemini API for audio transcription, image analysis, and video analysis to enrich message context for AI.
*   **Meta Cloud Media Upload Flow**: Handles downloading media from storage, uploading to Meta's API, and converting audio to compatible formats.
*   **Customizable Contact Data Extraction**: Allows businesses to define and extract custom fields from conversations using AI, stored in dedicated Prisma models.
*   **Intelligent Product Search**: Implements fuzzy matching using Levenshtein distance for product search with typo tolerance.
*   **Provider-Separated Token Usage Tracking**: Tracks token usage by provider (OpenAI/Gemini) and feature, displayed in the super admin dashboard.
*   **Pro-Tier Payment Links**: Restricts Stripe payment link generation to Pro users, while non-Pro users require manual order confirmation.
*   **Voucher-Based Payment Confirmation (V1)**: For non-Pro users, orders are created with AWAITING_VOUCHER status. When clients send payment proof images via WhatsApp, the system auto-attaches them to pending orders. Operators can view vouchers in the dashboard and confirm payments with a single click.
*   **Dual Business Objectives (SALES/APPOINTMENTS)**: Businesses can toggle between SALES mode (e-commerce with orders, products, delivery tracking) and APPOINTMENTS mode (service businesses with calendar scheduling, availability management). The sidebar dynamically shows relevant menu items and the AI agent registers appropriate tools based on the selected objective.
*   **Appointment Scheduling System**: Full CRUD for appointments with status tracking (PENDING, CONFIRMED, CANCELLED, COMPLETED, NO_SHOW), double-booking prevention using comprehensive overlap detection, and automatic reminder scheduling. Includes `agendar_cita` and `consultar_disponibilidad` AI tools for natural language scheduling.
*   **Business Availability Configuration**: Businesses can configure working hours per day of the week and block specific dates. The availability system validates all appointment requests against configured hours and existing bookings.
*   **Delivery Tracking**: Orders now include DELIVERED status with delivery agent assignment and delivery timestamp tracking. Quick action buttons in the Orders UI enable easy status progression (Paid → Processing → Shipped → Delivered).
*   **Agent Files Library (V1)**: Businesses can upload documents and images with metadata (triggerKeywords, triggerContext, order) that the AI uses to contextually send files during conversations. Files are stored in S3 and integrated via the "enviar_archivo" AI tool.
*   **Referral Code System**: Marketing tracking via referral codes with unique URLs (e.g., `/SIETEDIASGRATIS`). Codes can have descriptions, expiration dates, and active status. Registration flow validates codes and tracks user source. Super Admin dashboard includes full CRUD for code management with usage statistics.

*   **Distributed Buffer State Management**: Buffer processing state (activeBuffers, processingBuffers) moved from in-memory Maps to Redis for horizontal scalability. The `bufferStateService.ts` provides distributed locking via Redis SET NX for safe concurrent buffer processing across multiple API replicas.
*   **BullMQ Expired Buffer Processor**: Replaced the per-instance `setInterval(processExpiredBuffers)` with a BullMQ repeatable job that runs every 5 seconds. Only one worker processes expired buffers, preventing duplicate processing when running multiple Core API replicas. Falls back to legacy setInterval when Redis is unavailable.
*   **Atomic Buffer Claiming with DB Locking**: MessageBuffer model includes `processingUntil` field for atomic row-level locking. Processors use `updateMany` with WHERE clause to claim buffers atomically, preventing duplicate processing across replicas. 2-hour TTL covers queue backlog + processing + retries.
*   **Buffer-to-Worker Lifecycle Management**: AI jobs include `bufferId` for end-to-end tracking. Buffers are deleted ONLY after successful AI processing, not on enqueue. BullMQ configured with 3 attempts and exponential backoff (5s base). Lock extended during retries to prevent duplicate claims.
*   **Terminal State Handling**: Failed buffers after exhausting retries are quarantined with `failedAt`, `failureReason`, `retryCount` fields and a 1-year lock. Query failed buffers: `WHERE failedAt IS NOT NULL`. Manual intervention can reset for reprocessing.
*   **Synchronous Processing Fallback**: When Redis/BullMQ unavailable, system falls back to `processAIResponseDirect()` for immediate in-process AI handling, ensuring no message loss in degraded mode.

**System Design Choices**:
*   **Database**: PostgreSQL with Prisma ORM.
*   **Scalability**: Horizontally scalable Core API with stateless design. All interval-based jobs migrated to BullMQ repeatable jobs. State stored in Redis for multi-replica support.
*   **Security**: JWT-based authentication.
*   **Observability**: Message logging and tool execution history.

**Horizontal Scalability Limitations**:
*   The current buffer locking implementation uses a 2-hour TTL which should cover most production scenarios. However, in extreme cases (queue backlog > 2 hours, prolonged worker outages), there is a theoretical risk of duplicate buffer processing. For guaranteed single-claim semantics in high-load environments, consider implementing BullMQ progress hooks or a dedicated lock renewal worker.
*   Failed buffers are quarantined with failedAt/failureReason fields but require manual intervention via SQL to reprocess. Consider adding a Super Admin UI for failed buffer management.

## Scaling Guide (Docker Swarm)

### Services That Can Scale:
| Service | Scalable | Notes |
|---------|----------|-------|
| Core API | ✅ Yes | Requires Redis. Default 3 replicas, WORKER_CONCURRENCY=40. |
| Agent V2 | ✅ Yes | Stateless with Redis memory/cache. Default 2 replicas × 4 workers = 8 total. |
| Frontend | ✅ Yes | Stateless. Default 1 replica. |
| WhatsApp API (Baileys) | ⚠️ Limited | One instance per WhatsApp number due to session persistence. |
| WhatsApp API (Meta Cloud) | ✅ Yes | Fully scalable via webhooks. |

### Scaling Commands:
```bash
docker service scale efficore_core-api=4
docker service scale efficore_agent-v2=4
docker service scale efficore_frontend=3
```

### Capacity Estimates:
| Replicas (Core + V2) | Concurrent AI Requests | Businesses (40 clients each) |
|----------------------|------------------------|------------------------------|
| 3 + 2 (default) | ~200/min | 100-200 (~1,000 users) |
| 4 + 4 | ~320/min | 200-400 |
| 8 + 8 | ~640/min | 400-800 |

### Prerequisites for Scaling:
1. **Redis is REQUIRED** - Without Redis, duplicate processing will occur
2. **Database Connection Pooling** - Consider PgBouncer for >4 replicas
3. **WORKER_CONCURRENCY** env var controls AI parallelism per Core API replica (default: 40)
4. **WORKERS** env var controls gunicorn workers per Agent V2 replica (default: 4)

## External Dependencies

*   **PostgreSQL**: Primary database.
*   **MinIO**: Object storage service for media.
*   **OpenAI API**: For AI-powered chat responses and language models.
*   **Baileys**: Node.js library for WhatsApp Web API integration.
*   **Meta Cloud API (WhatsApp Business Platform)**: For official WhatsApp Business Account interactions.
*   **n8n**: For workflow automation integration.
*   **Docker / Docker Swarm**: For containerization and orchestration.
*   **Redis**: Message queue backend for BullMQ.
*   **Stripe**: Payment gateway for billing.
*   **Nodemailer**: For email sending in the email verification system.
*   **Google Gemini API**: For multimedia processing (audio transcription, image/video analysis).
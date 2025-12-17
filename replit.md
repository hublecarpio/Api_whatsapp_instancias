# WhatsApp SaaS Platform

## Overview
This project is a multi-tenant SaaS platform offering a WhatsApp API solution with integrated AI-powered chat automation. It enables businesses to manage WhatsApp communications, automate responses using AI, and integrate with external tools. The platform aims to streamline customer interactions, enhance business efficiency, and provide a robust, scalable communication channel. The vision is to deliver a comprehensive communication tool that leverages AI to transform customer service and engagement across various industries, tapping into the significant market potential of the SaaS and communication automation sectors.

## User Preferences
I prefer clear and concise explanations.
I value iterative development and expect to be consulted on major architectural changes.
Please provide detailed explanations for complex logic or decisions.
I prefer that the agent focuses on completing the current task rather than asking too many clarifying questions unless absolutely necessary for task completion.
Do not make changes to the `docker-stack-external-db.yml` file.

## System Architecture
The platform employs a microservices-like architecture with a **Frontend (Next.js)**, a **Core API (Node.js/Express)**, and a **WhatsApp API (Node.js/Baileys & Meta Cloud API)**.

**UI/UX Decisions**: Features a modern, WhatsApp-style chat panel, collapsible sidebar, AI Agent configuration, and accordion-style UI for orders. Branding includes a reusable `HubleFooter` component.

**Technical Implementations**:
*   **AI Pipeline**: Processes incoming WhatsApp messages using business context, conversation history, and OpenAI API for AI responses.
*   **Multi-Provider WhatsApp**: Supports both Baileys (WhatsApp Web) and Meta Cloud API.
*   **Meta Cloud API Integration**: Includes provider selection, webhooks, media sending, and Meta-approved message templates.
*   **AI Agent Tools**: Enables AI agents to call external POST endpoints with dynamic parameter interpolation.
*   **Reminder/Follow-up System**: Event-driven scheduling and cancellation of follow-ups, processed by a `reminderWorker` respecting business timezones. Features distributed lock with `processingAt` timestamp for multi-replica safety, automatic retry with exponential backoff (2min, 8min, 32min), enriched AI message generation using contact context (lead stage, tags, message count, pending orders, engagement level), and comprehensive metrics API (`getReminderStats`, `getFailedRemindersDetails`, `retryFailedReminder`).
*   **Redis + BullMQ Queue System**: Manages reminders, message buffering, WhatsApp messages, and AI responses with retry logic and high-concurrency for OpenAI API calls.
*   **Stripe Billing Integration**: Implements tiered pricing with BASIC ($29/month, 1.6M tokens) and PRO ($97/month, 5M tokens, webhooks, API keys). New user flow: 2-day trial without card (500K tokens), then 5-day trial with card on chosen plan. Referral codes add bonus demo days. Features recurring payments, webhooks, account suspension, and on-demand token credit purchases. Supports subscription freezing for enterprise users.
*   **Email Verification System**: Requires email verification for WhatsApp instance creation via SMTP.
*   **Robust Deployment**: Dockerized services with improved health checks.
*   **Super Admin Panel**: Centralized administration for command center, event logging, user/business management, WhatsApp instance control, token usage, billing, and referral codes.
*   **Centralized OpenAI API Management**: Uses a single platform-wide key, allows model selection, logs token usage, and optimizes tokens via conversation history truncation. Routes GPT-5+ models to Responses API and GPT-4/earlier to Chat Completions API.
*   **Dynamic AI Model Configuration**: Super Admin configurable default AI models (GPT-5/5.2/5.2-Pro) with reasoning effort. Businesses can override.
*   **Per-Contact Bot Control**: Global and per-contact toggles for bot functionality.
*   **Agent V2 - Multi-Agent AI System (Python/LangGraph)**: Advanced Python microservice with a 3-brain architecture (Vendor → Observer → Refiner), 5 executable tools, Redis-backed memory, OpenAI embeddings for semantic product search, and dynamic learning. Features dynamic runtime model refresh.
*   **Agent V2 State-Governed Architecture (v2.0 Hardened)**: Implements an 8-phase hardening roadmap transforming the agent into a state-governed system with `CommercialState` and `EtapaComercial`. LangGraph state-governed flow with tools as pure infrastructure.
*   **Agent V2 Simplified Graph with ReAct (v2.1)**: Refactored 2-agent architecture with feedback loop, Redis-persistent `CommercialState`, simplified validations, explicit state machine for tool governance, and ReAct retry mechanism.
*   **Agent V2 Custom Tools Support**: Exposes custom tools (prefixed `custom_`) to the Vendor LLM with native OpenAI function calling via `bind_tools()`, allowing dynamic HTTP requests via `CustomToolHandler`. Uses proper JSON schema with `additionalProperties: false` and type mapping.
*   **Agent V1 Custom Tools Support**: Native custom tools support in Agent V1 (Node.js) with OpenAI function calling. Custom tools are prefixed with `custom_` and execute HTTP requests with dynamic parameter interpolation. Supports bodyTemplate with `{{placeholder}}` syntax, dynamic context variables (contactPhone, contactName, businessId, businessName), and proper handling of arrays/objects. Content-Type header is automatically set based on body type.
*   **Production-Grade Baileys Stability**: Redis session state, watchdog heartbeat, rate limiting, error handling, and Docker restart persistence for automatic reconnection.
*   **Gemini Multimedia Processing**: Integrates Google Gemini API for audio transcription, image, and video analysis.
*   **Customizable Contact Data Extraction**: AI extracts custom fields from conversations.
*   **Automatic Lead Stage Updates**: Lead stages are automatically analyzed and updated after each complete interaction cycle (client message → AI response) using Gemini. Both Agent V1 and V2 receive the current lead stage as context to guide conversations appropriately.
*   **Intelligent Product Search**: Fuzzy matching with typo tolerance.
*   **Provider-Separated Token Usage Tracking**: Tracks token usage by provider and feature.
*   **Payment Mode Control**: `paymentLinkEnabled` toggle determines Stripe payment link vs. voucher-based order flow.
*   **Dual Business Objectives (SALES/APPOINTMENTS)**: Businesses can toggle between e-commerce (SALES) and service (APPOINTMENTS) modes, influencing UI and AI agent behavior.
*   **Appointment Scheduling System**: Full CRUD, status tracking, double-booking prevention, and automatic reminders with AI tools (`agendar_cita`, `consultar_disponibilidad`).
*   **Business Availability Configuration**: Allows businesses to configure working hours and block dates.
*   **Delivery Tracking**: Orders include `DELIVERED` status, delivery agent assignment, and quick actions.
*   **Agent Files Library (V1)**: Businesses upload documents and images for contextual AI use via the "enviar_archivo" AI tool.
*   **Contact CRM System**: Dedicated Contact table with automatic creation, tags, notes, email, message counts, timestamps, archive functionality, and full CRUD API with filtering. Expandable rows with inline editing.
*   **Enhanced Mass Broadcast System**: Supports direct file upload (MinIO) for media, text+media, CSV contact import, variable interpolation (CRM metadata, named variables), deduplication, Meta template component preservation, smart variable filtering, and validation. Includes WhatsApp group import for Baileys instances.
*   **Referral Code System**: Marketing tracking via unique URLs, with CRUD for codes and usage statistics. Extended with an affiliate program (`bonusDemoDays`, `bonusTrialDays`, `commissionRate`, `ownerUserId`) for users to claim and track their own referral codes.
*   **Advisor/Agent System**: Role-based access control for team members with invitation workflow and contact assignment.
*   **Round-Robin Lead Auto-Assignment**: Automatic lead distribution among advisors.
*   **Distributed Buffer State Management**: Buffer processing state in Redis with distributed locking for scalability.
*   **BullMQ Expired Buffer Processor**: Replaced interval processing with a BullMQ repeatable job for expired buffers.
*   **Atomic Buffer Claiming with DB Locking**: Uses `processingUntil` and `updateMany` for row-level locking.
*   **Buffer-to-Worker Lifecycle Management**: AI jobs track `bufferId`, buffers deleted post-AI processing.
*   **Terminal State Handling**: Failed buffers quarantined with `failedAt`, `failureReason`, `retryCount`.
*   **Synchronous Processing Fallback**: Falls back to `processAIResponseDirect()` when Redis/BullMQ are unavailable.
*   **Guided Onboarding with Effi**: New users see a fullscreen onboarding wizard featuring "Effi", an animated mascot character. The 3-step onboarding covers: 1) WhatsApp QR connection, 2) Quick product setup, 3) AI agent prompt configuration. Tracks completion via `onboardingCompleted` field in Business model. Registration now captures business name upfront.
*   **Delegated Agent System**: Super Admin can assign a user account as a "delegated agent" to track and follow up with platform users. Platform users are synced as contacts in the agent's business with a special tag ("Usuario App") and `platformUserId` link. Features: agent assignment/removal, automatic user sync, usage status tracking (active/partial/registered/unverified), and a dedicated Super Admin UI tab for managing the agent and viewing platform user contacts with conversion metrics.
*   **Phone Verification System**: Users can verify their contact phone numbers via WhatsApp OTP. 6-digit codes are sent through the Super Admin's delegated agent WhatsApp instance (Baileys or Meta Cloud). Features 10-minute code expiry, 2-minute resend throttling, E.164 phone format normalization, and automatic re-verification when phone number changes.

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
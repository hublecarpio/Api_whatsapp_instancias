# WhatsApp SaaS Platform

## Overview
This project is a multi-tenant SaaS platform offering a WhatsApp API solution with integrated AI-powered chat automation. It enables businesses to manage WhatsApp communications, automate responses using AI, and integrate with external tools. The platform aims to streamline customer interactions, enhance business efficiency, and provide a robust, scalable communication channel.

## User Preferences
I prefer clear and concise explanations.
I value iterative development and expect to be consulted on major architectural changes.
Please provide detailed explanations for complex logic or decisions.
I prefer that the agent focuses on completing the current task rather than asking too many clarifying questions unless absolutely necessary for task completion.
Do not make changes to the `docker-stack-external-db.yml` file.

## System Architecture
The platform utilizes a microservices-like architecture comprising a **Frontend (Next.js)**, a **Core API (Node.js/Express)**, and a **WhatsApp API (Node.js/Baileys & Meta Cloud API)**.

**UI/UX Decisions**: Features a modern WhatsApp-style chat panel, collapsible sidebar, AI Agent configuration, and accordion UI. A Super Admin can enable a Glassmorphism UI and configure white-label branding.

**Technical Implementations**:
*   **AI Pipeline**: Processes WhatsApp messages using business context, conversation history, and OpenAI API.
*   **Multi-Provider WhatsApp**: Supports Baileys (WhatsApp Web), Meta Cloud API, and Meta Coexistence (Embedded Signup + Coexistence flow) for connecting WhatsApp numbers.
*   **AI Agent System**:
    *   **Agent V2 (Python/LangGraph)**: Advanced multi-agent system with a 3-brain architecture (Vendor → Observer → Refiner), 5 executable tools, Redis-backed memory, OpenAI embeddings for semantic product search, and dynamic learning. Features a state-governed architecture and ReAct retry mechanism.
    *   **Custom Tools Support**: Allows AI agents to call external POST endpoints and utilize native OpenAI function calling.
*   **Reminder/Follow-up System**: Event-driven scheduling of follow-ups via BullMQ or polling, with AI-enriched message generation and Meta Cloud Template Configuration.
*   **Redis + BullMQ Queue System**: Manages reminders, message buffering, WhatsApp messages, and AI responses.
*   **Unified WhatsApp Sender Architecture**: Clean separation between Agent module (generates AI responses) and WhatsApp module (handles all sending):
    *   `whatsappSender.ts` service provides `queueAgentResponse()`, `queueMessage()`, `markMessageAsRead()`, and `isQueueAvailable()`
    *   All agent responses flow through `outboundMessageQueue` with proper credential handling per provider (Baileys, Meta Cloud, Meta Coexist)
    *   Provider-specific recipient normalization: Baileys uses digits-only, Meta preserves full IDs
    *   Messages saved to DB only after successful send in `outboundMessageProcessor`
    *   Legacy fallback via `sendAgentResponseDirect()` when Redis unavailable, with consistent metadata (contactJid, contactName)
*   **Stripe Billing Integration**: Implements tiered pricing, trial periods, recurring payments, webhooks, account suspension, and token credit purchases.
*   **Email Verification System**: Required for WhatsApp instance creation.
*   **Robust Deployment**: Dockerized services with improved health checks.
*   **Super Admin Panel**: Centralized administration for command center, event logging, user/business management, WhatsApp instance control, token usage, billing, referral codes, and global UI/branding customization.
*   **Centralized OpenAI API Management**: Uses a single platform-wide key, allows model selection, logs token usage, and optimizes tokens.
*   **Per-Contact Bot Control**: Global and per-contact toggles for bot functionality.
*   **Production-Grade Baileys Stability**: Includes Redis session state, watchdog, rate limiting, and error handling.
*   **Gemini Multimedia Processing**: Integrates Google Gemini API for audio transcription, image, and video analysis, including payment voucher validation.
*   **Customizable Contact Data Extraction**: Businesses configure custom fields for AI extraction from conversations, stored with confidence scores and source tracking.
*   **Automatic Lead Stage Updates**: Lead stages are updated after each interaction cycle using Gemini.
*   **Intelligent Product Search**: Fuzzy matching with typo tolerance, supports searching by product title, description, and variation field.
*   **Product Variations**: Products support an optional "variation" field for specifying size (100ml, 50ml), color (rojo, azul), weight (5kg, 2kg), or presentation (1 caja, 100 unidades). CSV import/export includes variation column.
*   **RAG-Based Objection Handling**: Objections are handled through RAG sections with category='OBJECTIONS' instead of predefined scripts, allowing dynamic responses based on business knowledge.
*   **Provider-Separated Token Usage Tracking**: Tracks token usage by provider and feature.
*   **Payment Mode Control**: Toggle for Stripe payment link vs. voucher-based order flow.
*   **Dual Business Objectives (SALES/APPOINTMENTS)**: Businesses can toggle between e-commerce and service modes.
*   **Appointment Scheduling System**: Full CRUD, status tracking, double-booking prevention, automatic reminders, and AI tools for scheduling, enhanced with **Google Calendar integration** supporting Google Meet link generation.
*   **Business Availability Configuration**: Configurable working hours and blocked dates.
*   **Delivery Tracking**: Orders include `DELIVERED` status, agent assignment, and quick actions.
*   **Agent Files Library (V1)**: Upload documents/images for contextual AI use.
*   **Contact CRM System**: Dedicated Contact table with automatic creation, tags, notes, email, message counts, and full CRUD API.
*   **Enhanced Mass Broadcast System**: Supports file upload (MinIO), CSV import, variable interpolation, and Meta template preservation.
*   **Referral Code System**: Marketing tracking via unique URLs and an affiliate program.
*   **Advisor/Agent System**: Role-based access control for team members with invitation workflow and contact assignment, including round-robin lead auto-assignment.
*   **Multi-Role User System**: Users can simultaneously own their own businesses and serve as advisors for other businesses, managed via a `UserBusinessRole` table and a ContextSwitcher component.
*   **Distributed Buffer State Management**: Buffer processing state in Redis with distributed locking and BullMQ.
*   **Guided Onboarding with Effi**: Fullscreen 3-step onboarding wizard for new users.
*   **Delegated Agent System**: Super Admin can assign a user as a "delegated agent" to track and follow up with platform users.
*   **Phone Verification System**: Users verify phone numbers via WhatsApp OTP through the Super Admin's delegated agent instance.
*   **Multi-Instance WhatsApp Support**: PRO/Enterprise users can connect multiple WhatsApp numbers, each with independent configuration.
*   **Sales Funnel System (Flujo de Venta)**: Sequential stage-based conversation flow where each stage has required data fields that must be collected before advancing, and topics that can be blocked until requirements are met. Integrates with ContactExtractedData for automatic stage progression.
*   **Intelligent Prompt Importer V2**: Multi-pass AI-powered onboarding tool that allows users to paste raw business context (products, prices, delivery zones, extraction fields, objection handling, funnel stages) and have Gemini 2.5 automatically parse and structure it into configuration data. Features:
    *   **Multi-Pass Chunking**: Processes texts up to 60k chars via intelligent chunking (6-8k chars with overlap)
    *   **Category-Specific Extraction**: Batched execution (2 parallel calls max) for rate-limit safety with retry/exponential backoff
    *   **Structured Data Extraction**: Processes up to 10 chunks for products, zones, extraction fields with deduplication
    *   **Confidence Scoring**: 0-1 confidence scores with evidence quotes; items <0.7 flagged as needsReview
    *   **3-Step Modal Flow**: Input raw text → AI-powered preview with diagnostics → import confirmation with detailed results
    *   **Conflict Detection**: Skip-on-conflict behavior to avoid overwriting existing data
*   **RAG Knowledge Architecture**: Scalable knowledge management system replacing monolithic prompts with structured, queryable sections. Features:
    *   **Structured Categories**: CORE, TONE, SALES, POLICIES, FAQ, OBJECTIONS, CLOSING, OTHER
    *   **Semantic Embeddings**: OpenAI text-embedding-3-small for non-core sections enabling RAG retrieval
    *   **Instance Isolation**: Sections support `instanceId` for multi-instance configuration with fallback to shared (null) sections
    *   **Priority System**: Core sections (priority 10) always included, non-core sections retrieved via cosine similarity + keyword boosting
    *   **Gemini-Powered Import**: `parsePromptToSections()` uses Gemini to automatically categorize raw prompts into structured sections
    *   **Content Suggestions**: `suggestMissingContent()` provides AI-generated suggestions for missing categories
*   **Early Order Creation System**: Orders created at STEP 3 (product + zone + payment method confirmed) instead of STEP 5. Features:
    *   **Partial Payments**: `paidAmount`, `pendingAmount`, `lastVoucherAmount` fields track cumulative payments
    *   **Multiple Vouchers**: Each voucher upload adds to paidAmount until totalAmount is reached
    *   **Payment History**: Full audit trail in `notes.paymentHistory[]` with amount, brand, operationCode, imageUrl, timestamps
    *   **Order Auto-Confirmation**: Status changes to PAID when paidAmount >= totalAmount
    *   **Zone Validation**: Enforces delivery zone requirement when business has zones configured
*   **Enhanced Production Debugging**: Structured logging with [ORDER-CREATE], [ORDER-VOUCHER], [ORDER-PAYMENT], [AI-*] tags, environment detection (REPLIT vs PRODUCTION), Redis availability tracking
*   **Intelligent Auto-Trigger System**: Pre-processing system that detects critical intents and executes required actions BEFORE the AI agent responds. Features:
    *   **Trigger Types**: VOUCHER_RECEIVED (detects payment proof via Gemini), PURCHASE_CONFIRMED (detects explicit purchase intent in text)
    *   **Pre-Execution Flow**: Trigger detection → action execution → context injection → AI response with accurate information
    *   **Voucher Auto-Processing**: Any image is validated as potential voucher regardless of existing order; auto-creates order from extracted data if missing
    *   **Context Injection**: Auto-trigger results are injected into AI agent context ensuring accurate responses about completed actions
    *   **Design Principle**: Don't trust AI to remember to call tools; for critical actions (payment processing, order creation), use explicit triggers that force execution
    *   **Fallback Minimal Order Creation**: When valid voucher received but extracted data incomplete (missing productos, direccion, nombre), system ALWAYS creates a minimal order with voucher amount, status PAID, and `needsDataCompletion: true` flag - prevents lost sales when AI agent fails to extract all fields
    *   **Files**: `autoTriggers.ts` (trigger detection/execution), `orderAutoCreator.ts` (order creation from extracted data)

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
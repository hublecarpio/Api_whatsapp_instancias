# WhatsApp SaaS Platform

## Overview
This project is a multi-tenant SaaS platform providing a WhatsApp API solution with integrated AI-powered chat automation. Its purpose is to enable businesses to manage WhatsApp communications, automate responses using AI, and integrate with external tools. The platform aims to streamline customer interactions, enhance business efficiency, and offer a robust, scalable communication channel. The business vision is to provide a comprehensive communication tool that leverages AI to transform customer service and engagement for various industries, offering significant market potential in the growing SaaS and communication automation sectors.

## User Preferences
I prefer clear and concise explanations.
I value iterative development and expect to be consulted on major architectural changes.
Please provide detailed explanations for complex logic or decisions.
I prefer that the agent focuses on completing the current task rather than asking too many clarifying questions unless absolutely necessary for task completion.
Do not make changes to the `docker-stack-external-db.yml` file.

## System Architecture
The platform utilizes a microservices-like architecture comprising a **Frontend (Next.js)**, a **Core API (Node.js/Express)**, and a **WhatsApp API (Node.js/Baileys & Meta Cloud API)**.

**UI/UX Decisions**: The frontend features a modern, WhatsApp-style chat panel with message bubbles, read receipts, and support for various media types, including a collapsible sidebar, AI Agent configuration, and an accordion-style UI for orders.

**Technical Implementations**:
*   **AI Pipeline**: Processes incoming WhatsApp messages using business context, conversation history, and OpenAI API for AI responses.
*   **Multi-Provider WhatsApp**: Supports both Baileys (WhatsApp Web) and Meta Cloud API (official accounts).
*   **Meta Cloud API Integration**: Includes provider selection, webhooks, media sending, and Meta-approved message templates with 24-hour conversation window management.
*   **AI Agent Tools**: Enables AI agents to call external POST endpoints with dynamic parameter interpolation.
*   **Message Buffering**: Accumulates messages before triggering AI responses.
*   **Multimodal Response Handling**: Automatically detects and sends various media types.
*   **Reminder/Follow-up System**: Background worker for inactivity detection and scheduling AI-generated follow-ups, respecting business timezones.
*   **Redis + BullMQ Queue System**: Robust job processing for reminders, message buffering, WhatsApp messages, and AI responses with retry logic. Features a high-concurrency BullMQ AI Response Queue for parallel OpenAI API calls.
*   **Stripe Billing Integration**: Implements a 7-day free trial, recurring payments, webhook handling, and account suspension.
*   **Email Verification System**: Requires email verification for WhatsApp instance creation, with server-side enforcement and SMTP integration.
*   **Robust Deployment**: Dockerized services with improved health checks and environment variable support.
*   **Super Admin Panel**: Centralized administration with Command Center (dashboard), DevConsole (event log viewer), user/business management, WhatsApp instance control, token usage tracking, billing, and referral code management.
*   **System Event Logging**: Centralized `eventLogger` service tracks all platform events with severity levels and metadata.
*   **Centralized OpenAI API Management**: Uses a single platform-wide OpenAI API key, allows model selection, and logs token usage. Features a unified `callOpenAI()` wrapper that automatically routes GPT-5+ models to the Responses API with optional reasoning effort, while GPT-4 and earlier use Chat Completions API. Includes token optimization via conversation history truncation.
*   **Dynamic AI Model Configuration**: Super Admin can configure default AI models for Agent V1 and V2 via PlatformSettings, with support for GPT-5/5.2/5.2-Pro and configurable reasoning effort (low/medium/high). Businesses can override with custom model selection.
*   **Per-Contact Bot Control**: Provides global and per-contact bot control with UI toggles.
*   **Dynamic Prompt Variables**: Supports dynamic variables like `{{now}}` with configurable timezones for OpenAI prompts.
*   **Agent V2 - Multi-Agent AI System (Python/LangGraph)**: Advanced Python microservice with a 3-brain architecture (Vendor → Observer → Refiner), 5 executable tools, Redis-backed memory, OpenAI embeddings for semantic product search, and dynamic learning. Features dynamic runtime model refresh - agents fetch platform model config from Core API (cached 60s) and rebuild LLM instances when config changes, enabling Super Admin model updates without service restart. Includes production-ready health checks with dependency validation (Redis/Core API/OpenAI), structured logging, and Docker Swarm deployment documentation (DOCKER_ENV.md).
*   **Production-Grade Baileys Stability**: Features Redis session state, watchdog heartbeat, rate limiting, and robust error handling.
*   **Gemini Multimedia Processing**: Integrates Google Gemini API for audio transcription, image analysis, and video analysis.
*   **Meta Cloud Media Upload Flow**: Handles media download, upload to Meta's API, and audio conversion.
*   **Customizable Contact Data Extraction**: Allows AI to define and extract custom fields from conversations.
*   **Intelligent Product Search**: Implements fuzzy matching for product search with typo tolerance.
*   **Provider-Separated Token Usage Tracking**: Tracks token usage by provider and feature.
*   **Pro-Tier Payment Links**: Restricts Stripe payment link generation to Pro users.
*   **Voucher-Based Payment Confirmation (V1)**: For non-Pro users, allows order confirmation via client-sent payment proof images.
*   **Dual Business Objectives (SALES/APPOINTMENTS)**: Businesses can toggle between e-commerce (SALES) and service (APPOINTMENTS) modes, dynamically adjusting UI and AI agent tools.
*   **Appointment Scheduling System**: Full CRUD for appointments, status tracking, double-booking prevention, and automatic reminders. Includes `agendar_cita` and `consultar_disponibilidad` AI tools.
*   **Business Availability Configuration**: Allows businesses to configure working hours and block dates.
*   **Delivery Tracking**: Orders include `DELIVERED` status, delivery agent assignment, and quick action buttons.
*   **Agent Files Library (V1)**: Businesses can upload documents and images with metadata for contextual AI use via the "enviar_archivo" AI tool.
*   **Contact CRM System**: Dedicated Contact table with automatic creation on first message, tags, notes, email, message counts, first/last message timestamps, archive functionality, and full CRUD API. Supports filtering by tags and archived status.
*   **Enhanced Mass Broadcast System**: Supports direct file upload to MinIO for images/videos/audio/documents, text+media together with captions, CSV contact import (phone,var1,var2 format), variable interpolation ({{1}}, {{2}}) for personalized messages, frontend and backend deduplication, and Meta template component preservation.
*   **Referral Code System**: Marketing tracking via unique referral URLs, with CRUD for codes and usage statistics.
*   **Advisor/Agent System**: Role-based access control for team members with invitation workflow and contact assignment.
*   **Round-Robin Lead Auto-Assignment**: Automatic lead distribution among selected advisors, configurable via the Team panel.
*   **Distributed Buffer State Management**: Buffer processing state moved to Redis for horizontal scalability, using distributed locking.
*   **BullMQ Expired Buffer Processor**: Replaced per-instance interval processing with a BullMQ repeatable job for expired buffers.
*   **Atomic Buffer Claiming with DB Locking**: Uses `processingUntil` field and `updateMany` for atomic row-level locking of message buffers.
*   **Buffer-to-Worker Lifecycle Management**: AI jobs track `bufferId`, and buffers are deleted only after successful AI processing.
*   **Terminal State Handling**: Failed buffers are quarantined with `failedAt`, `failureReason`, and `retryCount` fields.
*   **Synchronous Processing Fallback**: Falls back to `processAIResponseDirect()` when Redis/BullMQ are unavailable to prevent message loss.

**System Design Choices**:
*   **Database**: PostgreSQL with Prisma ORM.
*   **Scalability**: Horizontally scalable Core API with stateless design; state managed in Redis.
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
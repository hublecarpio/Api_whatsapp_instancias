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
*   **Multi-Provider WhatsApp**: Supports Baileys (WhatsApp Web) and Meta Cloud API, including template messages and webhooks.
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
# WhatsApp SaaS Platform

## Overview
This project is a multi-tenant SaaS platform providing a comprehensive WhatsApp API solution with integrated AI-powered chat automation. Its purpose is to enable businesses to efficiently manage WhatsApp communications, automate customer interactions using advanced AI, and integrate with various external tools. The platform aims to enhance business efficiency, streamline customer support, and offer a scalable communication channel, ultimately boosting customer satisfaction and operational productivity.

## User Preferences
I prefer clear and concise explanations.
I value iterative development and expect to be consulted on major architectural changes.
Please provide detailed explanations for complex logic or decisions.
I prefer that the agent focuses on completing the current task rather than asking too many clarifying questions unless absolutely necessary for task completion.
Do not make changes to the `docker-stack-external-db.yml` file.

## System Architecture
The platform employs a microservices-like architecture, consisting of a **Frontend (Next.js)**, a **Core API (Node.js/Express)**, and a dedicated **WhatsApp API (Node.js/Baileys & Meta Cloud API)**.

**UI/UX Decisions**: The platform features a modern, intuitive interface inspired by WhatsApp, including a chat panel, a collapsible sidebar, AI Agent configuration, and accordion UI elements. A Super Admin can enable a Glassmorphism UI and configure white-label branding.

**Technical Implementations**:
*   **AI Pipeline**: Processes WhatsApp messages using business context, conversation history, and OpenAI API for intelligent responses.
*   **Multi-Provider WhatsApp**: Supports Baileys (WhatsApp Web), Meta Cloud API, and Meta Coexistence for flexible WhatsApp number connectivity.
*   **AI Agent System**:
    *   **Agent V3 (Modular TypeScript)**: Features a robust, modular design with a Two-LLM Architecture:
        *   **LLM1 (gpt-4o-mini - Conversational)**: Responds to clients and delegates actions. Has minimal context: RAG knowledge, funnel stage rules, session memory, trigger context. Does NOT have product catalog or zone details. Only tool: `ejecutar_accion`.
        *   **LLM2 (gpt-4o - Executor/Orchestrator)**: Executes all actions via tools. Has full context: complete product catalog, delivery zones, conversation history (last 50 messages), session memory. Can iterate up to 5 times to complete complex objectives.
        *   **ToolMemory**: Persists products, totals, and orderId across turns via `_session_cart` in ContactExtractedData (30min expiry).
        *   **Tool Registry**: Dynamic registration of native and custom tools per business.
        *   **LLM Adapter**: Configurable model providers (OpenAI, OpenRouter).
    *   **Agent V2 (Python/LangGraph)**: An advanced multi-agent system with a 3-brain architecture, Redis-backed memory, OpenAI embeddings for semantic search, and dynamic learning capabilities.
*   **Reminder/Follow-up System**: Event-driven scheduling for follow-ups, with AI-enriched message generation.
*   **Redis + BullMQ Queue System**: Manages reminders, message buffering, and AI responses for scalability and reliability.
*   **Unified WhatsApp Sender Architecture**: Provides a clean separation between AI agent response generation and WhatsApp message sending, ensuring consistent and reliable message delivery across different providers.
*   **Stripe Billing Integration**: Handles tiered pricing, subscriptions, trial periods, and token credit purchases.
*   **Super Admin Panel**: Centralized control for user, business, WhatsApp instance management, billing, and global UI customization.
*   **Centralized OpenAI API Management**: Manages a single platform-wide OpenAI key, tracks token usage, and optimizes API calls.
*   **Per-Contact Bot Control**: Allows toggling bot functionality globally or per contact.
*   **Production-Grade Baileys Stability**: Ensures reliable Baileys integration with Redis session management, watchdog, and rate limiting.
*   **Gemini Multimedia Processing**: Integrates Google Gemini API for advanced audio transcription, image analysis (e.g., payment voucher validation), and video analysis.
*   **Customizable Contact Data Extraction**: Enables businesses to configure custom fields for AI-driven data extraction from conversations.
*   **Intelligent Product Search (Hybrid Semantic + Fuzzy)**: Uses OpenAI embeddings (text-embedding-3-small) with pgvector for semantic understanding, combined with fuzzy matching for typo tolerance. Understands that "perfume para hombre" matches "Caballero" in descriptions. Hybrid scoring: 60% semantic + 40% fuzzy weight.
*   **RAG-Based Objection Handling**: Dynamically handles customer objections using RAG sections categorized for business knowledge.
*   **Payment Mode Control**: Toggles between Stripe payment links and voucher-based order flows.
*   **Dual Business Objectives**: Supports both e-commerce (SALES) and service (APPOINTMENTS) modes.
*   **Appointment Scheduling System**: Provides full CRUD for appointments, prevents double-booking, and integrates with Google Calendar for enhanced scheduling.
*   **Contact CRM System**: Features a dedicated Contact table with automatic creation, tagging, notes, and full CRUD API.
*   **Enhanced Mass Broadcast System**: Supports file upload, CSV import, variable interpolation, and Meta template preservation.
*   **Referral Code System**: Facilitates marketing tracking and affiliate programs.
*   **Advisor/Agent System**: Implements role-based access control for team members with contact assignment and round-robin lead distribution.
*   **Multi-Role User System**: Allows users to manage multiple business roles concurrently via a ContextSwitcher.
*   **Guided Onboarding with Effi**: A 3-step fullscreen onboarding wizard for new users.
*   **Sales Funnel System (Flujo de Venta)**: A stage-based conversation flow with required data fields and topic blocking for guided user journeys.
*   **Intelligent Prompt Importer V2**: An AI-powered onboarding tool utilizing Gemini 2.5 to parse raw business context into structured configuration data, featuring multi-pass chunking, category-specific extraction, confidence scoring, and conflict detection.
*   **RAG Knowledge Architecture**: A scalable knowledge management system using structured categories, semantic embeddings for retrieval, instance isolation, and a priority system for content. Gemini powers the automatic categorization of raw prompts.
*   **Early Order Creation System**: Creates orders at an earlier stage (product + zone + payment method confirmed), supporting partial payments, multiple vouchers, and automatic order confirmation.
*   **Intelligent Auto-Trigger System**: A pre-processing system that detects critical intents (e.g., `VOUCHER_RECEIVED`, `PURCHASE_CONFIRMED`) and executes required actions before the AI agent responds, ensuring critical tasks like payment processing are handled proactively.
*   **Gemini-First Voucher Processing**: When Gemini detects a valid payment voucher, the system bypasses LLM1 and executes the auto-trigger directly to save the payment. LLM1 only receives the confirmation context (not the image URL or description), preventing confusion and ensuring reliable payment registration.

**System Design Choices**:
*   **Database**: PostgreSQL with Prisma ORM.
*   **Scalability**: Horizontally scalable, stateless Core API with state managed in Redis.
*   **Security**: JWT-based authentication.
*   **Observability**: Comprehensive logging for messages and tool execution.

## External Dependencies

*   **PostgreSQL**: Primary relational database.
*   **MinIO**: Object storage for files.
*   **OpenAI API**: AI models for natural language processing and generation.
*   **Baileys**: Un official WhatsApp Web API library.
*   **Meta Cloud API (WhatsApp Business Platform)**: Official WhatsApp Business API.
*   **n8n**: Workflow automation tool.
*   **Docker / Docker Swarm**: Containerization and orchestration.
*   **Redis**: In-memory data store and message broker.
*   **Stripe**: Payment processing gateway.
*   **Nodemailer**: Email sending service.
*   **Google Gemini API**: Advanced multimedia and language models.
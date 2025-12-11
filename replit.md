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
*   **Redis + BullMQ Queue System**: Uses Redis and BullMQ for robust job processing, including reminders, message buffering, and WhatsApp message handling, with automatic fallback and retry logic.
*   **Stripe Billing Integration**: Implements a 7-day free trial, weekly recurring payments via Stripe Checkout, webhook handling for payment events, and automatic account suspension.
*   **Email Verification System**: Requires email verification for users to create WhatsApp instances, with server-side enforcement, a dedicated UI, and SMTP integration.
*   **Robust Deployment**: Dockerized services with improved health checks, database wait logic, and environment variable support.
*   **Super Admin Panel**: A centralized administration panel for platform monitoring, user/business management, WhatsApp instance control, token usage tracking, billing overview, and system health.
*   **Centralized OpenAI API Management**: Uses a single platform-wide OpenAI API key, allows model selection, and logs token usage for cost tracking.
*   **Per-Contact Bot Control**: Provides two-level bot control (global and per-contact) with a `botDisabled` flag, UI toggles, and visual indicators.
*   **Dynamic Prompt Variables**: Supports dynamic variables like `{{now}}` with configurable timezones for businesses, replaced before sending prompts to OpenAI.
*   **Agent V2 - Multi-Agent AI System (Python/LangGraph)**: An advanced Python microservice with 3-brain architecture (Vendor → Observer → Refiner). Features 5 executable tools (search_product, payment, followup, media, crm), Redis-backed memory persistence, OpenAI embeddings for semantic product search, and dynamic learning system that saves rules per business. Restricted to Pro tier users.
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

**System Design Choices**:
*   **Database**: PostgreSQL with Prisma ORM.
*   **Scalability**: Multi-instance design for WhatsApp API.
*   **Security**: JWT-based authentication.
*   **Observability**: Message logging and tool execution history.

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
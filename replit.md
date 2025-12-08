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
*   **AI Agent Tools**: Allows the AI agent to call external POST endpoints with dynamic parameter interpolation based on conversation context.
*   **Message Buffering**: Accumulates messages for a configurable duration before triggering an AI response.
*   **Multimodal Response Handling**: Automatically detects and sends various media types (images, videos, files) and handles S3 shortcodes or full URLs.
*   **Reminder/Follow-up System**: Background worker for automatic inactivity detection and scheduling AI-generated follow-up messages or manual reminders.
*   **Robust Deployment**: Dockerized services with improved health checks, database wait logic, and environment variable support for flexible port configuration.

**System Design Choices**:
*   **Database**: PostgreSQL with Prisma ORM for type-safe database access and schema management.
*   **Scalability**: Multi-instance design for WhatsApp API allows scaling connections independently.
*   **Security**: JWT-based authentication for securing API endpoints.
*   **Observability**: Message logging and tool execution history for monitoring AI agent performance.

## External Dependencies

*   **PostgreSQL**: Primary database for all application data, managed via Prisma ORM.
*   **MinIO**: Object storage service used for media management (images, videos, files) associated with WhatsApp messages.
*   **OpenAI API**: Used by the AI pipeline for generating automated chat responses and leveraging advanced language models.
*   **Baileys**: A Node.js library for interacting with the WhatsApp Web API, used for direct WhatsApp integration.
*   **Meta Cloud API (WhatsApp Business Platform)**: Integrated for official WhatsApp Business Account interactions.
*   **n8n**: The platform is built for integration with n8n for workflow automation.
*   **Docker / Docker Swarm**: For containerization and orchestration of all services.
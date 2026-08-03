# ForgeGate - Backend Infrastructure Platform

ForgeGate is a production-ready, enterprise-grade backend infrastructure platform built with NestJS, TypeScript, Prisma ORM, PostgreSQL, Redis, RabbitMQ, Prometheus, and Docker Compose. It serves as a blueprint for modern backend architecture featuring authentication, role-based access control (RBAC), rate limiting, asynchronous task queues, audit logging, health monitoring, and observability.

---

## High-Level Architecture

```mermaid
flowchart TD
    Client[Client / Consumer] --> Gateway[API Gateway / NestJS App]
    
    subgraph Core Platform
        Gateway --> Auth[Auth Module - JWT / OAuth]
        Gateway --> User[User Module - RBAC]
        Gateway --> Audit[Audit Logging Module]
        Gateway --> Billing[Billing Module]
        Gateway --> Health[Health & Observability Module]
    end

    subgraph Infrastructure Services
        Auth --> Redis[(Redis Cache & Blacklist)]
        User --> Postgres[(PostgreSQL Primary DB)]
        Audit --> Postgres
        Billing --> Postgres
        Gateway --> Queue[RabbitMQ Task Queue]
        Health --> Prometheus[Prometheus Metrics]
    end
```

---

## Features

- **Authentication & Authorization**:
  - JWT Authentication (Access + Refresh token rotation)
  - Redis-backed token revocation / blacklist
  - Role-Based Access Control (RBAC) with granular permissions (Admin, Moderator, User)
  - OAuth 2.0 Integration (Google, GitHub)
- **API Gateway Features**:
  - Global validation pipe with class-validator
  - Centralized error handling and standardized HTTP responses
  - Redis-backed distributed rate limiting (per IP and per User)
- **Database & Data Modeling**:
  - PostgreSQL with Prisma ORM
  - Automatic migrations and database seeding script
  - Models: Users, Roles, Permissions, OAuth Accounts, Refresh Tokens, Audit Logs, Billing Plans, Subscriptions
- **Asynchronous Task Processing**:
  - RabbitMQ message broker for decoupled background processing
  - Asynchronous email notifications queue (Welcome emails, Password resets)
  - Dead-letter queue concept support
- **Audit Logging**:
  - Immutable audit logs capturing user actions, IP addresses, user agents, and metadata
- **Observability & Health Checks**:
  - Prometheus metrics endpoint (`/api/v1/metrics`)
  - Multi-service health monitoring (`/api/v1/health`) for PostgreSQL, Redis, and RabbitMQ
- **Containerization**:
  - Multi-stage Dockerfile optimized for production
  - Complete stack orchestration via Docker Compose

---

## Tech Stack

| Component | Technology |
| :--- | :--- |
| **Language & Runtime** | TypeScript, Node.js v20+ |
| **Framework** | NestJS |
| **Package Manager** | pnpm |
| **Database & ORM** | PostgreSQL 16, Prisma ORM |
| **Caching & Rate Limiting** | Redis 7, ioredis |
| **Message Queue** | RabbitMQ 3 (AMQP) |
| **Documentation** | OpenAPI 3.0 / Swagger |
| **Observability** | Prometheus, Winston |
| **Containerization** | Docker, Docker Compose |

---

## Getting Started

### Prerequisites

- Node.js v20 or higher
- pnpm (v8 or higher)
- Docker & Docker Compose

### Local Development Setup

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/NabarupDev/ForgeGate.git
   cd ForgeGate
   ```

2. **Install Dependencies**:
   ```bash
   pnpm install
   pnpm approve-builds --all
   ```

3. **Configure Environment Variables**:
   ```bash
   cp .env.example .env
   ```

4. **Start Infrastructure Services**:
   ```bash
   docker-compose up -d postgres redis rabbitmq prometheus
   ```

5. **Run Database Migrations & Seed Data**:
   ```bash
   pnpm run prisma:generate
   pnpm run prisma:migrate
   pnpm run prisma:seed
   ```

6. **Start Application**:
   ```bash
   # Development mode with watch
   pnpm run start:dev

   # Production build & start
   pnpm run build
   pnpm run start:prod
   ```

---

## Environment Variables Explanation

| Variable | Description | Default Value |
| :--- | :--- | :--- |
| `PORT` | Application server port | `3000` |
| `NODE_ENV` | Environment mode (`development`, `production`, `test`) | `development` |
| `API_PREFIX` | Global API route prefix | `api/v1` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://forgegate_user:forgegate_password@localhost:5432/forgegate_db?schema=public` |
| `REDIS_HOST` | Redis host address | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `RABBITMQ_URL` | RabbitMQ connection URL | `amqp://guest:guest@localhost:5672` |
| `RABBITMQ_QUEUE` | Queue name for background notification jobs | `notifications_queue` |
| `JWT_ACCESS_SECRET` | Secret key for access token signing | `super-secret-access-key` |
| `JWT_REFRESH_SECRET` | Secret key for refresh token signing | `super-secret-refresh-key` |
| `JWT_ACCESS_EXPIRES_IN` | Access token lifespan | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token lifespan | `7d` |

---

## API Documentation

Interactive Swagger documentation is available once the server is running.

- **Swagger UI**: [http://localhost:3000/api/v1/docs](http://localhost:3000/api/v1/docs)
- **Health Check**: [http://localhost:3000/api/v1/health](http://localhost:3000/api/v1/health)

---

## Running with Docker Compose

To start the full application stack including backend, PostgreSQL, Redis, RabbitMQ, and Prometheus with a single command:

```bash
docker-compose up --build
```

Access services at:
- **ForgeGate API**: `http://localhost:3000/api/v1`
- **Swagger Documentation**: `http://localhost:3000/api/v1/docs`
- **RabbitMQ Management Dashboard**: `http://localhost:15672` (Username: `guest`, Password: `guest`)
- **Prometheus Dashboard**: `http://localhost:9090`

---

## Future Improvements

- Add Grafana dashboard definitions and pre-configured JSON templates for real-time visualization.
- Implement Stripe webhook handlers for complete billing automation.
- Add GitHub Actions CI workflow for automated linting, unit testing, and Docker image builds.
- Introduce Distributed Tracing via OpenTelemetry and Jaeger.

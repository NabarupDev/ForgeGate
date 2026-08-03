# ForgeGate Architecture & System Design

ForgeGate is a distributed backend workflow platform designed as a modular monorepo.

## Microservices Breakdown

1. **API Gateway (`apps/api-gateway`)**:
   - Acts as the unified entry point behind Nginx reverse proxy.
   - Handles global request rate limiting, response normalization, and Swagger OpenAPI generation.

2. **Authentication Service (`apps/auth-service`)**:
   - Manages user registrations, login strategies, JWT access and refresh token rotation.
   - Revokes revoked tokens in Redis cache instantly.

3. **Workflow Engine Service (`apps/workflow-service`)**:
   - Manages state machine workflow executions.
   - Schedules background steps via BullMQ and Redis distributed queues.
   - Handles retry queues with exponential backoff recovery.

4. **Notification Service (`apps/notification-service`)**:
   - Consumes asynchronous notification events from RabbitMQ / BullMQ.
   - Dispatches email alerts and transactional webhooks.

## Internal Shared Packages

- `@forgegate/common`: Response formatters, exception filters.
- `@forgegate/logger`: Structured JSON Winston logger service.
- `@forgegate/auth`: RBAC decorators and token validation.
- `@forgegate/config`: Validated environment configuration schemas.

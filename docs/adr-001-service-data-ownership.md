# ADR-001: Service Data Ownership & Database Architecture

## Status
**Accepted**

## Context & Current State
ForgeGate is a microservices-based distributed workflow platform consisting of an API Gateway, Auth Service, Workflow Engine Service, and Notification Service.

Initially, all microservices accessed a single monolithic PostgreSQL database operating in a shared `public` schema. Data models across different domains (e.g., `User` in Auth vs. `Workflow` in Workflow Engine) had direct relational foreign-key dependencies (`@relation`) within Prisma.

## Problem Statement
Sharing a single database schema and maintaining foreign-key relationships across domain boundaries introduces tight coupling between microservices:
1. **Domain Boundary Violations**: Services could execute direct relational joins across table boundaries (e.g., querying `Workflow` with joined `User` entity objects), blurring microservice ownership lines.
2. **Schema Evolution Friction**: Changes to Auth data models could break Workflow or Audit features if schema changes were made without coordinated cross-team deployment.
3. **Database-per-Service Dilemma**: While splitting into independent physical PostgreSQL instances is the classic microservices pattern, doing so prematurely introduces heavy operational overhead (managing multiple connection pools, distributed transactions, 2PC, complex local development setups) before throughput dictates physical separation.

## Decision: Logical Service Data Ownership via PostgreSQL Multi-Schema

We have chosen **Logical Service Data Ownership** using PostgreSQL multi-schema support (`schemas = ["auth", "workflow", "audit", "billing"]`) on a single database cluster.

### Domain Ownership Mapping
| Domain | Schema | Microservice Owner | Models |
| :--- | :--- | :--- | :--- |
| **Auth** | `auth` | `auth-service` | `Tenant`, `User`, `Role`, `Permission`, `RolePermission`, `OAuthAccount`, `RefreshToken` |
| **Workflow Engine** | `workflow` | `workflow-service` | `Workflow`, `WorkflowStep`, `WorkflowExecution`, `StepExecution`, `ExecutionLog` |
| **Audit** | `audit` | Audit Service / Event Subscriptions | `AuditLog` |
| **Billing** | `billing` | Billing Service / Gateway | `Subscription` |

### Key Design Principles

1. **Decoupled Relational Boundaries**: Direct `@relation` linkages across schema boundaries have been removed. Services store loose UUID identifier attributes (`createdById`, `userId`, `tenantId`) instead of foreign key constraints across schemas.
2. **Service API & Event Communication**: Microservices query their own schema tables exclusively. Cross-domain data fetching (e.g., enriching user profile info for a workflow creator) must occur via HTTP service APIs or asynchronous event streams (BullMQ/Redis).
3. **Deferred Physical Separation**: We retain a single PostgreSQL instance for local development and initial production deployment. This eliminates distributed transaction complexity while strictly enforcing logical data boundaries.

## Why Physical Database Separation Was Deferred
- **Operational Simplicity**: A single PostgreSQL instance simplifies deployment, backup strategies, and migration pipelines.
- **No Distributed Transactions**: Prevents 2PC (Two-Phase Commit) or Saga pattern overhead for simple transactions within logical boundaries.
- **Zero Cross-Query Leakage**: By separating models into `auth.*`, `workflow.*`, `audit.*`, and `billing.*` schemas and removing cross-schema `@relation` mappings in Prisma, PostgreSQL and Prisma enforce strict logical boundaries identical to separate databases.

## Future Migration Path
Should system throughput, tenant isolation, or organizational growth require physical database separation:

1. **Phase 1 (Current)**: Multi-schema isolation on a single PostgreSQL instance (`auth.*`, `workflow.*`, `audit.*`, `billing.*`).
2. **Phase 2 (Connection String Splitting)**: Update service environment variables (`AUTH_DATABASE_URL`, `WORKFLOW_DATABASE_URL`) to point to separate database users with permissions restricted solely to their respective schemas.
3. **Phase 3 (Physical Database Provisioning)**: Dump and restore individual PostgreSQL schemas onto distinct physical PostgreSQL clusters (e.g., AWS RDS instances) without requiring any code changes in the microservices.

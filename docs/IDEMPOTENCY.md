# ForgeGate HTTP Workflow Step Idempotency Model

## Overview

ForgeGate guarantees durable **at-least-once** workflow step execution paired with configurable **idempotency mechanisms** for external HTTP providers.

---

## Technical Limitation Notice

> **Important**: ForgeGate cannot guarantee exactly-once side-effects against arbitrary third-party external HTTP APIs. If a downstream service does not support idempotency headers or transaction deduplication, retrying after a network failure or worker crash may re-trigger external actions. ForgeGate provides durable execution tracking combined with automated `Idempotency-Key` header propagation for providers that support it.

---

## Idempotency Key Format

ForgeGate constructs a stable, tenant-isolated idempotency key for every logical workflow step:

```text
forgegate:{tenantId}:{executionId}:{stepId}
```

### Key Properties

1. **Stability Across Retries**: The key remains identical for all retry attempts of the same logical step within a given workflow execution.
2. **Execution Isolation**: Genuinely new workflow executions receive unique idempotency keys.
3. **Tenant Isolation**: Keys include `tenantId` to prevent multi-tenant collision or cross-tenant leakage.
4. **BullMQ Independence**: The key is derived from the workflow domain identifiers rather than transient BullMQ job IDs.

---

## Downstream HTTP Configuration

Idempotency key header forwarding is configurable per workflow step to avoid sending unexpected headers to non-supporting third-party services.

```json
{
  "actionType": "http_request",
  "config": {
    "url": "https://api.stripe.com/v1/charges",
    "method": "POST",
    "idempotency": {
      "enabled": true,
      "headerName": "Idempotency-Key"
    }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `idempotency.enabled` | `boolean` | `false` | Enables forwarding the computed idempotency key in HTTP headers. |
| `idempotency.headerName` | `string` | `"Idempotency-Key"` | Custom HTTP header name (e.g. `X-Idempotency-Key` or `Idempotency-Key`). |

---

## Execution Matrix & Engine Behaviors

| Scenario | Engine / Provider Action |
|---|---|
| **First Attempt** | Generates stable key `forgegate:{tenantId}:{executionId}:{stepId}`. If downstream idempotency is enabled, attaches header and executes HTTP request. |
| **Retry (Attempt 2+)** | Reuses identical idempotency key. Downstream provider recognizes duplicate key and safely returns previous result. |
| **Worker Crash** | If worker crashes after downstream provider processes request, recovery worker re-enqueues step. Retry uses identical key. |
| **Duplicate Worker Race** | Atomic database claim (`PENDING -> RUNNING`) ensures only one worker claims step execution. Second worker fails claim and aborts execution. |
| **Successful Previous Attempt** | Database lookup detects existing `SUCCEEDED` `StepExecution` record, skips HTTP call entirely, and returns cached output. |
| **Failed / Timed-Out Attempt** | Database lookup permits retry execution using the stable idempotency key. |
| **Provider Supports Idempotency** | Set `"idempotency": { "enabled": true }`. Header is attached automatically. |
| **Provider Does Not Support Idempotency** | Omit `"idempotency"` configuration. Header is omitted to ensure third-party compatibility. |

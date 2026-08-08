export interface StepIdempotencyConfig {
  enabled?: boolean;
  headerName?: string;
}

/**
 * Generates a stable, tenant-isolated idempotency key for a logical workflow step.
 * Format: forgegate:{tenantId}:{executionId}:{stepId}
 */
export function generateStepIdempotencyKey(
  tenantId: string,
  executionId: string,
  stepId: string,
): string {
  const cleanTenant = tenantId || 'default';
  const cleanExecution = executionId || 'unknown-exec';
  const cleanStep = stepId || 'unknown-step';
  return `forgegate:${cleanTenant}:${cleanExecution}:${cleanStep}`;
}

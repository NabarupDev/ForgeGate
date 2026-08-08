export const DEFAULT_HTTP_TIMEOUT_MS = 5000;
export const MAX_GLOBAL_HTTP_TIMEOUT_MS = 60000; // 60 seconds safe global upper limit

export function resolveHttpTimeout(configTimeoutMs: any): number {
  if (configTimeoutMs === undefined || configTimeoutMs === null || configTimeoutMs === '') {
    return DEFAULT_HTTP_TIMEOUT_MS;
  }

  const parsed = Number(configTimeoutMs);

  if (isNaN(parsed) || !isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid timeoutMs configuration: ${configTimeoutMs}. Must be a positive number.`);
  }

  if (parsed > MAX_GLOBAL_HTTP_TIMEOUT_MS) {
    return MAX_GLOBAL_HTTP_TIMEOUT_MS;
  }

  return Math.floor(parsed);
}

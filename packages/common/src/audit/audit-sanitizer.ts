export interface AuditLogCreateInput {
  tenantId?: string | null;
  userId?: string | null;
  action: string;
  correlationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, any> | null;
}

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'authorization',
  'authheader',
  'secret',
  'apikey',
  'api_key',
  'jwt',
  'cookie',
  'credentials',
  'privatekey',
  'private_key',
]);

/**
 * Recursively sanitizes metadata by redacting any sensitive keys/secrets.
 */
export function sanitizeAuditMetadata(metadata?: Record<string, any> | null): Record<string, any> | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }

  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(metadata)) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
    
    if (SENSITIVE_KEYS.has(normalizedKey) || Array.from(SENSITIVE_KEYS).some(s => normalizedKey.includes(s))) {
      sanitized[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeAuditMetadata(value);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map(item => (item && typeof item === 'object' ? sanitizeAuditMetadata(item) : item));
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

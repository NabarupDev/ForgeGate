export type HttpErrorCategory =
  | 'PERMANENT_FAILURE'
  | 'TRANSIENT_FAILURE'
  | 'RATE_LIMITED'
  | 'NETWORK_FAILURE'
  | 'TIMEOUT';

export interface HttpClassificationResult {
  category: HttpErrorCategory;
  isRetryable: boolean;
  statusCode?: number;
  subReason?: string;
  retryAfterSeconds?: number | null;
  message: string;
  url?: string;
  method?: string;
}

export class HttpStepError extends Error {
  public readonly category: HttpErrorCategory;
  public readonly isRetryable: boolean;
  public readonly statusCode?: number;
  public readonly subReason?: string;
  public readonly retryAfterSeconds: number | null;
  public readonly url?: string;
  public readonly method?: string;

  constructor(classification: HttpClassificationResult) {
    super(classification.message);
    this.name = 'HttpStepError';
    this.category = classification.category;
    this.isRetryable = classification.isRetryable;
    this.statusCode = classification.statusCode;
    this.subReason = classification.subReason;
    this.retryAfterSeconds = classification.retryAfterSeconds ?? null;
    this.url = classification.url;
    this.method = classification.method;
  }

  toJSON() {
    return {
      name: this.name,
      category: this.category,
      isRetryable: this.isRetryable,
      statusCode: this.statusCode,
      subReason: this.subReason,
      retryAfterSeconds: this.retryAfterSeconds,
      message: this.message,
      url: this.url,
      method: this.method,
    };
  }
}

export function parseRetryAfterHeader(headerVal: any): number | null {
  if (!headerVal) return null;
  const strVal = String(headerVal).trim();
  const numSecs = parseInt(strVal, 10);
  if (!isNaN(numSecs) && String(numSecs) === strVal) {
    return numSecs >= 0 ? numSecs : null;
  }

  // Attempt HTTP Date parsing
  const dateMs = Date.parse(strVal);
  if (!isNaN(dateMs)) {
    const diffSecs = Math.ceil((dateMs - Date.now()) / 1000);
    return diffSecs >= 0 ? diffSecs : 0;
  }

  return null;
}

export function classifyHttpError(error: any, url?: string, method?: string): HttpStepError {
  const methodStr = (method || 'GET').toUpperCase();
  const targetUrl = url || 'unknown';

  // 1. Response received from server (HTTP status code error)
  if (error.response) {
    const status = error.response.status;
    const headers = error.response.headers || {};
    const retryAfterHeader = headers['retry-after'] || headers['Retry-After'];
    const retryAfterSeconds = parseRetryAfterHeader(retryAfterHeader);

    if (status === 429) {
      return new HttpStepError({
        category: 'RATE_LIMITED',
        isRetryable: true,
        statusCode: status,
        subReason: 'rate_limited',
        retryAfterSeconds,
        message: `HTTP ${methodStr} to ${targetUrl} failed: Rate limit exceeded (429)`,
        url: targetUrl,
        method: methodStr,
      });
    }

    if (status === 408) {
      return new HttpStepError({
        category: 'TRANSIENT_FAILURE',
        isRetryable: true,
        statusCode: status,
        subReason: 'request_timeout',
        message: `HTTP ${methodStr} to ${targetUrl} failed: Request timeout (408)`,
        url: targetUrl,
        method: methodStr,
      });
    }

    if ([400, 401, 403, 404, 409].includes(status) || (status >= 400 && status < 500)) {
      return new HttpStepError({
        category: 'PERMANENT_FAILURE',
        isRetryable: false,
        statusCode: status,
        subReason: `client_error_${status}`,
        message: `HTTP ${methodStr} to ${targetUrl} failed: Client error (${status})`,
        url: targetUrl,
        method: methodStr,
      });
    }

    if ([500, 502, 503, 504].includes(status) || status >= 500) {
      return new HttpStepError({
        category: 'TRANSIENT_FAILURE',
        isRetryable: true,
        statusCode: status,
        subReason: `server_error_${status}`,
        retryAfterSeconds,
        message: `HTTP ${methodStr} to ${targetUrl} failed: Server error (${status})`,
        url: targetUrl,
        method: methodStr,
      });
    }
  }

  // 2. Request level / network / timeout errors (no response received)
  const code = (error.code || '').toUpperCase();
  const errMsg = error.message || '';

  if (code === 'ECONNREFUSED') {
    return new HttpStepError({
      category: 'NETWORK_FAILURE',
      isRetryable: true,
      subReason: 'connection_refused',
      message: `HTTP ${methodStr} to ${targetUrl} failed: ${errMsg || 'Connection refused'}`,
      url: targetUrl,
      method: methodStr,
    });
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new HttpStepError({
      category: 'NETWORK_FAILURE',
      isRetryable: true,
      subReason: 'dns_failure',
      message: `HTTP ${methodStr} to ${targetUrl} failed: ${errMsg || 'DNS resolution failed'}`,
      url: targetUrl,
      method: methodStr,
    });
  }

  if (code === 'ECONNRESET') {
    return new HttpStepError({
      category: 'NETWORK_FAILURE',
      isRetryable: true,
      subReason: 'connection_reset',
      message: `HTTP ${methodStr} to ${targetUrl} failed: ${errMsg || 'Connection reset'}`,
      url: targetUrl,
      method: methodStr,
    });
  }

  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return new HttpStepError({
      category: 'TIMEOUT',
      isRetryable: true,
      subReason: 'socket_timeout',
      message: `HTTP ${methodStr} to ${targetUrl} failed: ${errMsg || 'Socket timeout'}`,
      url: targetUrl,
      method: methodStr,
    });
  }

  if (
    code === 'ECONNABORTED' ||
    errMsg.toLowerCase().includes('timeout') ||
    errMsg.toLowerCase().includes('timed out')
  ) {
    return new HttpStepError({
      category: 'TIMEOUT',
      isRetryable: true,
      subReason: 'request_timeout',
      message: `HTTP ${methodStr} to ${targetUrl} failed: ${errMsg || 'Request timeout'}`,
      url: targetUrl,
      method: methodStr,
    });
  }

  // Fallback for unknown network / request error
  return new HttpStepError({
    category: 'TRANSIENT_FAILURE',
    isRetryable: true,
    subReason: 'unknown_http_error',
    message: `HTTP ${methodStr} to ${targetUrl} failed: ${errMsg || 'Unknown HTTP error'}`,
    url: targetUrl,
    method: methodStr,
  });
}

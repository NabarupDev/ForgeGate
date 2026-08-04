import { LoggerService as NestLoggerService } from '@nestjs/common';
export interface LogMetadata {
    context?: string;
    traceId?: string;
    tenantId?: string;
    workflowId?: string;
    executionId?: string;
    durationMs?: number;
    [key: string]: any;
}
export declare class StructuredLogger implements NestLoggerService {
    private logger;
    constructor(serviceName?: string);
    log(message: any, contextOrMeta?: string | LogMetadata): void;
    error(message: any, trace?: string, contextOrMeta?: string | LogMetadata): void;
    warn(message: any, contextOrMeta?: string | LogMetadata): void;
    debug(message: any, contextOrMeta?: string | LogMetadata): void;
    verbose(message: any, contextOrMeta?: string | LogMetadata): void;
    logEvent(event: string, meta: LogMetadata): void;
}

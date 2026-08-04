import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import * as winston from 'winston';

export interface LogMetadata {
  context?: string;
  traceId?: string;
  tenantId?: string;
  workflowId?: string;
  executionId?: string;
  durationMs?: number;
  [key: string]: any;
}

@Injectable()
export class StructuredLogger implements NestLoggerService {
  private logger: winston.Logger;

  constructor(serviceName: string = 'ForgeGate') {
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      ),
      defaultMeta: { service: serviceName },
      transports: [
        new winston.transports.Console(),
      ],
    });
  }

  log(message: any, contextOrMeta?: string | LogMetadata) {
    if (typeof contextOrMeta === 'object') {
      this.logger.info(message, contextOrMeta);
    } else {
      this.logger.info(message, { context: contextOrMeta });
    }
  }

  error(message: any, trace?: string, contextOrMeta?: string | LogMetadata) {
    if (typeof contextOrMeta === 'object') {
      this.logger.error(message, { trace, ...contextOrMeta });
    } else {
      this.logger.error(message, { trace, context: contextOrMeta });
    }
  }

  warn(message: any, contextOrMeta?: string | LogMetadata) {
    if (typeof contextOrMeta === 'object') {
      this.logger.warn(message, contextOrMeta);
    } else {
      this.logger.warn(message, { context: contextOrMeta });
    }
  }

  debug(message: any, contextOrMeta?: string | LogMetadata) {
    if (typeof contextOrMeta === 'object') {
      this.logger.debug(message, contextOrMeta);
    } else {
      this.logger.debug(message, { context: contextOrMeta });
    }
  }

  verbose(message: any, contextOrMeta?: string | LogMetadata) {
    if (typeof contextOrMeta === 'object') {
      this.logger.verbose(message, contextOrMeta);
    } else {
      this.logger.verbose(message, { context: contextOrMeta });
    }
  }

  logEvent(event: string, meta: LogMetadata) {
    this.logger.info(event, meta);
  }
}

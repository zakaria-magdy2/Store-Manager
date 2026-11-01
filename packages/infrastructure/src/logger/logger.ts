export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * All optional fields declared with `| undefined` to satisfy `exactOptionalPropertyTypes`.
 */
export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context: Record<string, unknown> | undefined;
  correlationId: string | undefined;
  error:
    | {
        name: string;
        message: string;
        stack: string | undefined;
      }
    | undefined;
}

export class Logger {
  constructor(private readonly serviceName: string = 'RetailOS') {}

  public debug(message: string, context?: Record<string, unknown>, correlationId?: string): void {
    this.log('DEBUG', message, context, correlationId);
  }

  public info(message: string, context?: Record<string, unknown>, correlationId?: string): void {
    this.log('INFO', message, context, correlationId);
  }

  public warn(message: string, context?: Record<string, unknown>, correlationId?: string): void {
    this.log('WARN', message, context, correlationId);
  }

  public error(
    message: string,
    error?: Error,
    context?: Record<string, unknown>,
    correlationId?: string,
  ): void {
    const errorDetails:
      | { name: string; message: string; stack: string | undefined }
      | undefined = error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : undefined;

    this.log('ERROR', message, context, correlationId, errorDetails);
  }

  private log(
    level: LogLevel,
    message: string,
    context: Record<string, unknown> | undefined,
    correlationId: string | undefined,
    error?: { name: string; message: string; stack: string | undefined },
  ): void {
    const sanitizedContext = context ? this.sanitize(context) : undefined;
    const entry: LogEntry = {
      level,
      message: `[${this.serviceName}] ${message}`,
      timestamp: new Date().toISOString(),
      correlationId,
      context: sanitizedContext,
      error,
    };

    const serialized = JSON.stringify(entry);
    if (level === 'ERROR') {
      console.error(serialized);
    } else if (level === 'WARN') {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }
  }

  private sanitize(obj: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKeys = ['password', 'token', 'secret', 'key', 'pin', 'hash', 'credential'];
    const copy: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(obj)) {
      if (sensitiveKeys.some((s) => k.toLowerCase().includes(s))) {
        copy[k] = '[REDACTED]';
      } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        copy[k] = this.sanitize(v as Record<string, unknown>);
      } else {
        copy[k] = v;
      }
    }
    return copy;
  }
}

export const defaultLogger = new Logger();

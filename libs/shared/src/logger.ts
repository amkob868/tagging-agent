export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  requestId?: string;
  data?: Record<string, unknown>;
}

let currentRequestId: string | undefined;

/**
 * Set the current request ID for log correlation
 */
export function setRequestId(requestId: string): void {
  currentRequestId = requestId;
}

/**
 * Get the current request ID
 */
export function getRequestId(): string | undefined {
  return currentRequestId;
}

/**
 * Clear the current request ID
 */
export function clearRequestId(): void {
  currentRequestId = undefined;
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    requestId: currentRequestId,
    data,
  };

  const logFn = level === 'ERROR' ? console.error :
                level === 'WARN' ? console.warn :
                console.log;

  logFn(JSON.stringify(entry));
}

export const logger = {
  debug: (message: string, data?: Record<string, unknown>) => log('DEBUG', message, data),
  info: (message: string, data?: Record<string, unknown>) => log('INFO', message, data),
  warn: (message: string, data?: Record<string, unknown>) => log('WARN', message, data),
  error: (message: string, data?: Record<string, unknown>) => log('ERROR', message, data),
};

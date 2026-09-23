import pino, { type Logger as PinoLogger } from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';
import { filterFields } from './allowlist';

export interface LogContext {
  correlationId?: string;
  tenantId?: string;
  brandId?: string;
  runId?: string;
  publicationId?: string;
  workflowId?: string;
}

const contextStorage = new AsyncLocalStorage<LogContext>();
export const withLogContext = <T>(ctx: LogContext, fn: () => Promise<T>): Promise<T> =>
  contextStorage.run({ ...(contextStorage.getStore() ?? {}), ...ctx }, fn);
export const currentLogContext = (): LogContext => contextStorage.getStore() ?? {};

export interface Logger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
  child(component: string): Logger;
}

function wrap(p: PinoLogger): Logger {
  const emit =
    (level: 'debug' | 'info' | 'warn' | 'error') => (fields: Record<string, unknown>, msg: string) => {
      const merged = filterFields({ ...currentLogContext(), ...fields });
      p[level](merged, msg);
    };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (component) => wrap(p.child({ component })),
  };
}

let root: PinoLogger | null = null;
export function createLogger(opts: {
  service: string;
  env?: string;
  level?: string;
  destination?: pino.DestinationStream;
}): Logger {
  root = pino(
    {
      level: opts.level ?? process.env['LOG_LEVEL'] ?? 'info',
      base: { service: opts.service, env: opts.env ?? process.env['NODE_ENV'] ?? 'development' },
      messageKey: 'msg',
      timestamp: pino.stdTimeFunctions.isoTime,
      // Belt and braces: pino redaction on top of the allowlist, for nested objects a caller passes under an allowed key.
      redact: {
        paths: [
          '*.token',
          '*.accessToken',
          '*.refreshToken',
          '*.secret',
          '*.password',
          '*.authorization',
          '*.cookie',
        ],
        censor: '[redacted]',
      },
    },
    opts.destination,
  );
  return wrap(root);
}

export const logger = (): Logger => {
  if (!root) return createLogger({ service: process.env['OREMEDIA_SERVICE'] ?? 'oremedia' });
  return wrap(root);
};

/** Summarises an error for logs without leaking internals into user-facing messages. */
export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      errorName: err.name,
      errorMessage: err.message.slice(0, 500),
      ...(typeof code === 'string' ? { errorCode: code } : {}),
    };
  }
  return { errorName: 'NonError', errorMessage: String(err).slice(0, 500) };
}

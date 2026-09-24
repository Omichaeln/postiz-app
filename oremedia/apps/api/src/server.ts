import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { logger, errorFields, count, record, METRIC } from '@oremedia/observability';
import { NotFoundError, toErrorEnvelope } from '@oremedia/contracts/errors';
import { appRouter } from './router';
import { createContext } from './context';

/**
 * Log fields for an unhandled (INTERNAL) error. Driver messages embed user data (ER_DUP_ENTRY quotes the
 * duplicate value, e.g. an invited email), so quoted substrings are elided; code, name and errno stay.
 */
export function internalErrorFields(err: unknown): Record<string, unknown> {
  const fields = errorFields(err);
  const errno = (err as { errno?: unknown } | undefined)?.errno;
  return {
    ...fields,
    ...(typeof errno === 'number' ? { errno } : {}),
    errorMessage: String(fields['errorMessage'] ?? '').replace(/'[^']*'|"[^"]*"/g, '…'),
  };
}

export interface ServerOptions {
  webOrigin?: string;
  reviewPortalOrigin?: string;
}

/** Spec 4.3 request path and spec 18 security headers. */
export function createServer(opts: ServerOptions = {}): Express {
  const app = express();
  const log = logger().child('api');
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  const allowedOrigins = new Set(
    [opts.webOrigin, opts.reviewPortalOrigin].filter((o): o is string => Boolean(o)),
  );
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'content-type, authorization, idempotency-key, x-oremedia-tenant, x-oremedia-csrf, x-correlation-id',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    res.on('finish', () => {
      const durationMs = Date.now() - started;
      // The procedure path (bounded: the router map) on both, so each journey's error ratio is per procedure.
      const path = req.path.split('/').slice(0, 3).join('/');
      count(METRIC.httpRequests, 1, { status: res.statusCode, path });
      record(METRIC.httpDurationMs, durationMs, { path });
      log.info(
        { method: req.method, path: req.path.slice(0, 200), statusCode: res.statusCode, durationMs },
        'request',
      );
    });
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use(
    '/trpc',
    express.json({ limit: '2mb' }),
    createExpressMiddleware({
      router: appRouter,
      createContext: ({ req }) => createContext(req.headers, req.ip), // trust proxy 1: the client's address
      onError: ({ error, path }) => {
        if (error.code === 'INTERNAL_SERVER_ERROR')
          log.error({ path, ...internalErrorFields(error.cause ?? error) }, 'unhandled error');
      },
      maxBodySize: 2 * 1024 * 1024,
    }),
  );

  // Fallback for anything outside tRPC (public REST arrives in Phase 5): a consistent envelope.
  app.use((req, res) => {
    res
      .status(404)
      .json(
        toErrorEnvelope(
          new NotFoundError('Route', req.path.slice(0, 200)),
          (req.headers['x-correlation-id'] as string | undefined) ?? 'unknown',
        ),
      );
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error(errorFields(err), 'express error');
    res.status(500).json(toErrorEnvelope(err, 'unknown'));
  });
  return app;
}

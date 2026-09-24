import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { toErrorEnvelope, ValidationFailedError } from '@oremedia/contracts/errors';
import { invokeRestRoute, resolveRoute, type RestRoute, type RestRouteSpec } from './route';
import { AGENT_ROUTES } from './routes/agents';
import { ASSET_ROUTES } from './routes/assets';
import { BRAND_ROUTES } from './routes/brands';
import { CHANNEL_ROUTES } from './routes/channels';
import { CONTENT_ROUTES } from './routes/content';
import { INSIGHT_ROUTES } from './routes/insights';
import { PUBLICATION_ROUTES } from './routes/publications';
import { REVIEW_ROUTES } from './routes/review';

/** Spec 7.6 public REST route table. The OpenAPI contract and the cross-tenant harness enumerate it. */
export const REST_ROUTE_SPECS: readonly RestRouteSpec[] = [
  ...BRAND_ROUTES,
  ...ASSET_ROUTES,
  ...CONTENT_ROUTES,
  ...REVIEW_ROUTES,
  ...PUBLICATION_ROUTES,
  ...CHANNEL_ROUTES,
  ...AGENT_ROUTES,
  ...INSIGHT_ROUTES,
];

let resolved: RestRoute[] | null = null;
/** Every REST route bound to its procedure (spec 19.3: generated from the route table, like allProcedures). */
export function allRestRoutes(): RestRoute[] {
  resolved ??= REST_ROUTE_SPECS.map(resolveRoute);
  return resolved;
}

const correlationIdOf = (req: Request): string =>
  (req.headers['x-correlation-id'] as string | undefined)?.slice(0, 64) ?? 'unknown';

/** The /v1 Express router; `onInternal` logs an unhandled failure (the client only sees the INTERNAL envelope). */
export function createRestRouter(onInternal: (route: RestRoute, cause: unknown) => void): Router {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));
  for (const route of allRestRoutes()) {
    const handler = async (req: Request, res: Response, next: NextFunction) => {
      try {
        const out = await invokeRestRoute(route, {
          headers: req.headers,
          params: req.params as Record<string, string>,
          query: req.query as Record<string, unknown>,
          body: req.body,
          remoteAddress: req.ip, // trust proxy 1: the client's address
        });
        if (out.failure !== undefined) onInternal(route, out.failure);
        res.status(out.status).set(out.headers).json(out.body);
      } catch (err) {
        next(err);
      }
    };
    const path = route.path.slice('/v1'.length);
    if (route.method === 'GET') router.get(path, handler);
    else router.post(path, handler);
  }
  // A malformed JSON body is the caller's error: VALIDATION_FAILED, not INTERNAL.
  router.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if ((err as { type?: string } | null)?.type === 'entity.parse.failed') {
      res
        .status(400)
        .json(
          toErrorEnvelope(
            new ValidationFailedError([{ path: 'body', issue: 'malformed JSON' }]),
            correlationIdOf(req),
          ),
        );
      return;
    }
    next(err);
  });
  return router;
}

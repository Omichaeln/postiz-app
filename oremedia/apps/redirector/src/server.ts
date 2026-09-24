import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { assignVariant, visitorHash } from '@oremedia/contracts/visitor-assignment';
import { logger } from '@oremedia/observability';
import type { ClickBuffer } from './click-buffer';
import type { LinkResolver, ResolvedArm, ResolvedLink } from './links';

/** Prefixed id with a 26-character Crockford body (an app may not import the domain package's generator). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newClickId = (): string => `lc_${[...randomBytes(26)].map((b) => CROCKFORD[b % 32]).join('')}`;

/** Short codes are what `tracked_links.short_code` holds: up to 16 URL-safe characters. */
const SHORT_CODE = /^[A-Za-z0-9_-]{4,16}$/;

export interface RedirectorOptions {
  resolver: Pick<LinkResolver, 'resolve'>;
  clicks: ClickBuffer;
  /** Keyed hashing secret (Appendix A: LINK_HASH_SECRET_REF); rotating it changes every visitor id. */
  hashSecret: string;
  /** Trust X-Forwarded-For from the platform's proxy (Railway) for the visitor hash. */
  trustProxy?: boolean;
}

/**
 * Spec 16.6: where the visitor goes and which link the click counts against. The entry link of a running
 * randomised experiment assigns the visitor (hashed per tenant and day) with the shared pure function and sends
 * them to the arm's destination; the click is recorded on the arm's link, which carries the experiment variant.
 */
export function redirectTarget(
  link: ResolvedLink,
  hash: string,
): { trackedLinkId: string; destination: string; variantId: string | null } {
  if (!link.experimentId || !link.arms?.length)
    return { trackedLinkId: link.id, destination: link.destination, variantId: null };
  const variantId = assignVariant(
    hash,
    link.experimentId,
    link.arms.map((a) => ({ id: a.variantId, allocationWeight: a.allocationWeight })),
  );
  const arm = link.arms.find((a) => a.variantId === variantId) ?? (link.arms[0] as ResolvedArm);
  return { trackedLinkId: arm.trackedLinkId, destination: arm.destination, variantId: arm.variantId };
}

/**
 * Spec 15.4: GET /<code> resolves the tracked link, buffers a hashed click and answers 302 without waiting on the
 * database. Unknown codes are 404; the service holds no tenant context and serves no other data.
 */
export function createRedirector(opts: RedirectorOptions): express.Express {
  const app = express();
  const log = logger().child('redirector');
  if (opts.trustProxy) app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, buffered: opts.clicks.size() });
  });
  app.get('/:code', async (req, res) => {
    const code = String(req.params['code'] ?? '');
    if (!SHORT_CODE.test(code)) {
      res.status(404).end();
      return;
    }
    const correlationId = String(req.header('x-correlation-id') ?? randomUUID()).slice(0, 64);
    let link;
    try {
      link = await opts.resolver.resolve(code, correlationId);
    } catch (err) {
      log.error(
        { correlationId, errorMessage: err instanceof Error ? err.message : String(err) },
        'link lookup failed',
      );
      res.status(503).end();
      return;
    }
    if (!link) {
      res.status(404).end();
      return;
    }
    const now = new Date();
    const hash = visitorHash(
      opts.hashSecret,
      link.tenantId,
      `${req.ip ?? ''}|${req.header('user-agent') ?? ''}`,
      now,
    );
    const target = redirectTarget(link, hash);
    opts.clicks.add({
      id: newClickId(),
      tenantId: link.tenantId,
      brandId: link.brandId,
      trackedLinkId: target.trackedLinkId,
      visitorHash: hash,
      occurredAt: now,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, target.destination);
  });
  return app;
}

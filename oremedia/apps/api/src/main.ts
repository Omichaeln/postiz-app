import { startTelemetry, stopTelemetry } from '@oremedia/observability';
import { configureDatabase, closeDatabase } from '@oremedia/db';
import { createServer } from './server';
import { configureRateLimiter } from './trpc';
import { composeModules } from './composition';

const log = startTelemetry({ service: 'oremedia-api', version: process.env['OREMEDIA_VERSION'] });
const url = process.env['DATABASE_URL'];
if (!url) {
  log.error({}, 'DATABASE_URL is required');
  process.exit(2);
}
configureDatabase({ url, connectionLimit: Number(process.env['DATABASE_POOL'] ?? 10) });
composeModules();

if (process.env['REDIS_URL']) {
  const { default: Redis } = await import('ioredis');
  configureRateLimiter(new Redis(process.env['REDIS_URL'], { maxRetriesPerRequest: 2, lazyConnect: false }));
} else {
  configureRateLimiter();
  log.warn({}, 'REDIS_URL not set: using in-memory rate limiting (single instance only)');
}

const port = Number(process.env['PORT'] ?? 3001);
const app = createServer({
  webOrigin: process.env['WEB_ORIGIN'],
  reviewPortalOrigin: process.env['REVIEW_PORTAL_ORIGIN'],
});
const server = app.listen(port, () => log.info({ status: port }, 'api listening'));

const shutdown = async () => {
  server.close();
  await closeDatabase();
  await stopTelemetry();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

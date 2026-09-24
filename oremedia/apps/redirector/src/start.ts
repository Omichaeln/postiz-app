import { closeDatabase, configureDatabase } from '@oremedia/db';
import { startTelemetry, stopTelemetry } from '@oremedia/observability';
import { createClickBuffer } from './click-buffer';
import { createLinkResolver } from './links';
import { createRedirector } from './server';

const log = startTelemetry({ service: 'oremedia-redirector', version: process.env['OREMEDIA_VERSION'] });
configureDatabase({
  url: process.env['DATABASE_URL'] as string,
  connectionLimit: Number(process.env['DATABASE_POOL'] ?? 2),
});
const resolver = createLinkResolver();
const clicks = createClickBuffer({
  write: (rows) => resolver.insertClicks(rows),
  log: log.child('redirector'),
});
clicks.start();
const app = createRedirector({
  resolver,
  clicks,
  hashSecret: process.env['LINK_HASH_SECRET_REF'] as string,
  trustProxy: process.env['TRUST_PROXY'] === '1',
});
const server = app.listen(Number(process.env['PORT'] ?? 3002), () => log.info({}, 'redirector listening'));

const shutdown = async () => {
  server.close();
  await clicks.stop(); // drain the buffer before the pool closes
  await closeDatabase();
  await stopTelemetry();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

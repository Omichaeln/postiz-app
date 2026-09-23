/** Pre-deploy migration entrypoint (Railway `preDeployCommand`): applies versioned migrations, then exits. */
import { startTelemetry, stopTelemetry } from '@oremedia/observability';
import { closeDatabase, runMigrations } from '@oremedia/db';

const log = startTelemetry({ service: 'oremedia-api-migrate' });
const url = process.env['DATABASE_URL'];
if (!url) {
  log.error({}, 'DATABASE_URL is required');
  process.exit(2);
}
try {
  await runMigrations(url);
  log.info({}, 'migrations applied');
} catch (err) {
  log.error({ errorMessage: err instanceof Error ? err.message : String(err) }, 'migration failed');
  process.exitCode = 1;
} finally {
  await closeDatabase();
  await stopTelemetry();
}

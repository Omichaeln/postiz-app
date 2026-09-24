/**
 * Pre-deploy seeding entrypoint (Railway `preDeployCommand`, after migrate): registers the Release 1 built-in
 * skills (spec 10.4) as platform skills, then exits. Idempotent by key; a package that already exists is skipped.
 */
import { startTelemetry, stopTelemetry } from '@oremedia/observability';
import { closeDatabase, configureDatabase } from '@oremedia/db';
import { seedBuiltinSkills } from '@oremedia/module-skills';

const log = startTelemetry({ service: 'oremedia-api-seed-builtin-skills' });
const url = process.env['DATABASE_URL'];
if (!url) {
  log.error({}, 'DATABASE_URL is required');
  process.exit(2);
}
try {
  configureDatabase({ url });
  const result = await seedBuiltinSkills();
  log.info(
    { count: result.seeded.length, status: `skipped ${result.skipped.length}` },
    'built-in skills seeded',
  );
} catch (err) {
  log.error({ errorMessage: err instanceof Error ? err.message : String(err) }, 'seeding failed');
  process.exitCode = 1;
} finally {
  await closeDatabase();
  await stopTelemetry();
}

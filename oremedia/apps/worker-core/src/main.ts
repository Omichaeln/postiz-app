/**
 * Process entry for worker-core. The configuration gate runs before any dependency is loaded (this file imports
 * only Node built-ins), so a misconfigured container fails fast with the missing variable named, never with a
 * module-resolution error from deep inside a dependency. The worker itself is ./worker.ts.
 */
const REQUIRED = ['DATABASE_URL', 'TEMPORAL_ADDRESS'] as const;

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length) {
  for (const name of missing)
    console.error(
      JSON.stringify({
        level: 50,
        service: 'oremedia-worker-core',
        msg: `${name} is required`,
        time: Date.now(),
      }),
    );
  process.exit(2);
}

await import(new URL('./worker.js', import.meta.url).href);

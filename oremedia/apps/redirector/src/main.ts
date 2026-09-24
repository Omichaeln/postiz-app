/**
 * Process entry for the redirector (spec 15.4). The configuration gate runs before any dependency is loaded, as in
 * the other apps; the service itself is ./worker.ts-style in server.ts.
 */
const REQUIRED = ['DATABASE_URL', 'LINK_HASH_SECRET_REF'] as const;

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length) {
  for (const name of missing)
    console.error(
      JSON.stringify({
        level: 50,
        service: 'oremedia-redirector',
        msg: `${name} is required`,
        time: Date.now(),
      }),
    );
  process.exit(2);
}

await import(new URL('./start.js', import.meta.url).href);

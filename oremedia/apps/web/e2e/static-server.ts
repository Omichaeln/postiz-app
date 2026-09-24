import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { URL } from 'node:url';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export interface StaticServerOptions {
  dist: string;
  /** In-process tRPC handler for `/trpc/*` (UI-only smoke) ... */
  trpcHandler?: RequestListener;
  /** ... or an API origin to proxy `/trpc/*` to (real API smoke). */
  apiOrigin?: string;
}

/** Serves the built app (SPA fallback to index.html) and routes /trpc to the mock or the real API. */
export async function startStaticServer(
  opts: StaticServerOptions,
): Promise<{ server: Server; origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/trpc/')) {
      if (opts.trpcHandler) return opts.trpcHandler(req, res);
      if (opts.apiOrigin) return proxy(req, res, opts.apiOrigin);
      res.statusCode = 502;
      res.end('no API configured');
      return;
    }
    let file = join(opts.dist, normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!existsSync(file) || statSync(file).isDirectory())
      file = join(opts.dist, url.pathname.startsWith('/review-portal') ? 'review-portal.html' : 'index.html');
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function proxy(req: IncomingMessage, res: ServerResponse, apiOrigin: string): void {
  const target = new URL(req.url ?? '/', apiOrigin);
  const upstream = httpRequest(
    target,
    { method: req.method, headers: { ...req.headers, host: target.host } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    res.statusCode = 502;
    res.end(String(err));
  });
  req.pipe(upstream);
}

import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import { createProviderIO, type ProviderIO } from '../io';
import type { RateLimiter } from '../rate-limiter';

/*
 * Test-only fixture dispatcher (spec 14.6 "error fixtures captured"). Handwritten or recorded HTTP exchanges are
 * served by a real loopback HTTP server, and adapters reach it through the real `createProviderIO` (SSRF-safe
 * dispatcher with `insecureAllowLoopback`, explicit timeout, send tracking), so before/after-send classification
 * is exercised for real rather than mocked.
 */

export interface FixtureRequestMatch {
  method: string;
  /** The platform host the adapter targeted (e.g. api.linkedin.com); the rewriting IO carries it in a header. */
  host?: string;
  /** Decoded path, e.g. /rest/socialActions/urn:li:share:1/comments. */
  path: string;
  /** Subset of decoded query parameters that must be present with these values. */
  query?: Record<string, string>;
  /** Substrings the request body must contain (JSON, form or multipart text). */
  bodyIncludes?: string[];
}

export interface FixtureResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  body?: string;
}

export interface FixtureExchange {
  note?: string;
  request: FixtureRequestMatch;
  response?: FixtureResponse;
  /** hang: never answer (client times out after send); reset: destroy the socket after the request was read. */
  behaviour?: 'hang' | 'reset';
  /** Serve this exchange any number of times (polling reads). */
  repeat?: boolean;
}

export interface FixtureScenario {
  description?: string;
  exchanges: FixtureExchange[];
}

export interface FixtureFile {
  provider: string;
  scenarios: Record<string, FixtureScenario>;
}

export interface RecordedRequest {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  bodyBytes: number;
}

const BODY_TEXT_LIMIT = 64 * 1024;

export class FixtureServer {
  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private port = 0;
  private queue: Array<{ exchange: FixtureExchange; used: boolean }> = [];
  readonly requests: RecordedRequest[] = [];
  readonly unmatched: RecordedRequest[] = [];

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Loads a scenario; resets recordings. Exchanges are consumed in order, first unconsumed match wins. */
  load(scenario: FixtureScenario): this {
    this.queue = scenario.exchanges.map((exchange) => ({ exchange, used: false }));
    this.requests.length = 0;
    this.unmatched.length = 0;
    return this;
  }

  /** Non-repeat exchanges not yet served: tests assert 0 to prove a flow made exactly the expected calls. */
  remaining(): FixtureExchange[] {
    return this.queue.filter((q) => !q.used && !q.exchange.repeat).map((q) => q.exchange);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', this.baseUrl);
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => {
        query[k] = v;
      });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers))
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : (v ?? '');
      const recorded: RecordedRequest = {
        method: (req.method ?? 'GET').toUpperCase(),
        host: headers['x-fixture-host'] ?? url.host,
        path: safeDecode(url.pathname),
        query,
        headers,
        body: raw.subarray(0, BODY_TEXT_LIMIT).toString('latin1'),
        bodyBytes: raw.length,
      };
      this.requests.push(recorded);
      const hit = this.queue.find(
        (q) => (!q.used || q.exchange.repeat) && matches(q.exchange.request, recorded),
      );
      if (!hit) {
        this.unmatched.push(recorded);
        res.writeHead(599, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            fixture: 'unmatched',
            request: { method: recorded.method, host: recorded.host, path: recorded.path, query },
          }),
        );
        return;
      }
      hit.used = true;
      const { behaviour, response } = hit.exchange;
      if (behaviour === 'hang') return; // the client's AbortSignal.timeout fires: after_send
      if (behaviour === 'reset') {
        req.socket.destroy();
        return;
      }
      const r = response ?? { status: 204 };
      const body = r.json !== undefined ? JSON.stringify(r.json) : (r.body ?? '');
      res.writeHead(r.status, {
        ...(r.json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(r.headers ?? {}),
      });
      res.end(body);
    });
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function matches(m: FixtureRequestMatch, r: RecordedRequest): boolean {
  if (m.method.toUpperCase() !== r.method) return false;
  if (m.host && m.host !== r.host) return false;
  if (m.path !== r.path) return false;
  if (m.query && Object.entries(m.query).some(([k, v]) => r.query[k] !== v)) return false;
  if (m.bodyIncludes && m.bodyIncludes.some((s) => !r.body.includes(s))) return false;
  return true;
}

/** Reads a scenario from a fixture JSON file next to the test (`new URL('./fixtures/publish.json', import.meta.url)`). */
export function loadScenario(file: URL, name: string): FixtureScenario {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as FixtureFile;
  const scenario = parsed.scenarios[name];
  if (!scenario) throw new Error(`fixture ${file.pathname} has no scenario "${name}"`);
  return scenario;
}

export interface FixtureIO extends ProviderIO {
  /** Every request the adapter made, with the mutation flag it declared (spec 14.5 heartbeat/mutation accounting). */
  calls: Array<{ method: string; url: string; mutation: boolean }>;
}

export interface FixtureIOOptions {
  providerKey: string;
  tenantId?: string;
  timeoutMs?: number;
  limiter?: RateLimiter;
  /** Point every request at a closed loopback port instead of the fixture server (connection refused: before_send). */
  refuse?: boolean;
}

/** A closed loopback port: nothing listens, so a connect is refused at the socket. */
export async function closedLoopbackPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/**
 * A ProviderIO built with the real `createProviderIO` that rewrites every platform URL to the fixture server,
 * preserving path and query and carrying the original host in `x-fixture-host`.
 */
export async function fixtureIO(server: FixtureServer, opts: FixtureIOOptions): Promise<FixtureIO> {
  process.env['LOG_LEVEL'] ??= 'silent';
  const base = opts.refuse ? `http://127.0.0.1:${await closedLoopbackPort()}` : server.baseUrl;
  const inner = createProviderIO({
    providerKey: opts.providerKey,
    tenantId: opts.tenantId ?? 'ten_test',
    timeoutMs: opts.timeoutMs ?? 400,
    limiter: opts.limiter ?? { acquire: async () => undefined },
    insecureAllowLoopback: true,
  });
  const calls: FixtureIO['calls'] = [];
  return {
    calls,
    async request(url, init, meta) {
      const original = new URL(url);
      calls.push({ method: (init.method ?? 'GET').toUpperCase(), url, mutation: meta.mutation });
      const headers = headersToRecord(init.headers);
      headers['x-fixture-host'] = original.host;
      return inner.request(`${base}${original.pathname}${original.search}`, { ...init, headers }, meta);
    },
  };
}

function headersToRecord(h: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (Array.isArray(h)) {
    for (const pair of h) {
      const [k, v] = pair;
      if (typeof k === 'string' && typeof v === 'string') out[k.toLowerCase()] = v;
    }
    return out;
  }
  if (typeof (h as Headers).forEach === 'function') {
    (h as Headers).forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = v;
  return out;
}

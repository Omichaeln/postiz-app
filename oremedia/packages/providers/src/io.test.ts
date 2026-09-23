import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createProviderIO, ProviderTransportError } from './io';
import type { RateLimiter } from './rate-limiter';

const limiter: RateLimiter = { acquire: async () => undefined };

describe('ProviderIO (spec 14.5): timeouts, send tracking, before/after send classification', () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'p1' }));
      } else if (req.url === '/slow') {
        // never responds: the client must time out (after_send)
      } else if (req.url === '/reset') {
        req.socket.destroy();
      } else if (req.url === '/429') {
        res.writeHead(429, { 'retry-after': '3' });
        res.end('rate limited');
      } else {
        res.writeHead(500);
        res.end('boom');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const io = () =>
    createProviderIO({
      providerKey: 'test',
      tenantId: 'ten_1',
      timeoutMs: 400,
      limiter,
      insecureAllowLoopback: true,
    });

  it('returns the response with phase after_send', async () => {
    const { res, phase } = await io().request(
      `http://127.0.0.1:${port}/ok`,
      { method: 'POST', body: '{}' },
      { mutation: true },
    );
    expect(res.status).toBe(200);
    expect(phase).toBe('after_send');
  });
  it('a timeout after the request was sent is after_send (never retried by the caller)', async () => {
    await expect(
      io().request(`http://127.0.0.1:${port}/slow`, { method: 'POST', body: '{}' }, { mutation: true }),
    ).rejects.toMatchObject({ name: 'ProviderTransportError', phase: 'after_send' });
  });
  it('a socket reset after send is after_send', async () => {
    await expect(
      io().request(`http://127.0.0.1:${port}/reset`, { method: 'POST', body: '{}' }, { mutation: true }),
    ).rejects.toMatchObject({ phase: 'after_send' });
  });
  it('a connection refused before send is before_send', async () => {
    // A port that was just released: nothing listens, so the connect is refused at the socket.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const err = await io()
      .request(`http://127.0.0.1:${closedPort}/x`, { method: 'POST', body: '{}' }, { mutation: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderTransportError);
    expect((err as ProviderTransportError).phase).toBe('before_send');
  });
  it('a blocked address is refused before any connection', async () => {
    await expect(
      io().request('https://169.254.169.254/latest/meta-data', {}, { mutation: false }),
    ).rejects.toThrow(/Blocked address/);
    await expect(io().request('http://10.0.0.1/x', {}, { mutation: false })).rejects.toThrow(
      /http: is not allowed/,
    );
  });
  it('records heartbeat detail per request and counts 429s', async () => {
    const details: string[] = [];
    const { res } = await io().request(
      `http://127.0.0.1:${port}/429`,
      { method: 'GET' },
      { mutation: false, heartbeat: (d) => details.push(d) },
    );
    expect(res.status).toBe(429);
    expect(details[0]).toMatch(/^read GET http:\/\/127\.0\.0\.1:\d+\/429$/);
  });
});

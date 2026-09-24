import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { Agent, request } from 'undici';
import { assertSafeUrl, isBlockedIp, ssrfSafeDispatcher, ssrfSafeLookup } from './ssrf';

describe('SSRF guard (spec 18, 20.2)', () => {
  afterEach(() => vi.restoreAllMocks());
  it('blocks private, loopback, link-local, CGNAT, multicast, reserved and metadata ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.5.5',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '240.0.0.1',
      '198.18.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      'fc00::1',
      '::ffff:10.0.0.1',
      'ff02::1',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '104.16.0.1'])
      expect(isBlockedIp(ip), ip).toBe(false);
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
  it('pins DNS: literal blocked addresses and blocked hostnames fail before any connection', async () => {
    await expect(
      new Promise((res, rej) => ssrfSafeLookup('169.254.169.254', {}, (e, a) => (e ? rej(e) : res(a)))),
    ).rejects.toThrow(/Blocked address/);
    await expect(
      new Promise((res, rej) =>
        ssrfSafeLookup('metadata.google.internal', {}, (e, a) => (e ? rej(e) : res(a))),
      ),
    ).rejects.toThrow(/Blocked address/);
    await expect(
      new Promise((res, rej) => ssrfSafeLookup('localhost', {}, (e, a) => (e ? rej(e) : res(a)))),
    ).rejects.toThrow(/Blocked address/);
    expect(
      await new Promise((res, rej) => ssrfSafeLookup('8.8.8.8', {}, (e, a) => (e ? rej(e) : res(a)))),
    ).toBe('8.8.8.8');
  });
  it('URL policy: https only, no credentials, no blocked hosts; loopback only when explicitly allowed outside production', () => {
    expect(() => assertSafeUrl('http://api.example.com/x')).toThrow(/http: is not allowed/);
    expect(() => assertSafeUrl('https://user:pw@api.example.com/x')).toThrow(/credentials/);
    expect(() => assertSafeUrl('https://169.254.169.254/latest')).toThrow(/Blocked/);
    expect(() => assertSafeUrl('https://localhost/x')).toThrow(/Blocked/);
    expect(assertSafeUrl('https://api.linkedin.com/v2/posts').hostname).toBe('api.linkedin.com');
    expect(assertSafeUrl('http://127.0.0.1:1234/x', { insecureAllowLoopback: true }).port).toBe('1234');
  });

  it('IPv6 in any notation: embedded IPv4 (mapped, compatible, 6to4) is judged by the IPv4 it carries', () => {
    for (const ip of [
      '0:0:0:0:0:0:0:1',
      '::',
      '::ffff:7f00:1', // 127.0.0.1, the form WHATWG URL serialises ::ffff:127.0.0.1 to
      '::ffff:a9fe:a9fe', // 169.254.169.254 (cloud metadata)
      '0:0:0:0:0:ffff:a00:1',
      '::127.0.0.1',
      '::ffff:0:7f00:1',
      '2002:a9fe:a9fe::1',
      '64:ff9b::a9fe:a9fe',
      '2001::1',
      'fec0::1',
      'febf::1',
      '1::2::3',
    ])
      expect(isBlockedIp(ip), ip).toBe(true);
    for (const ip of ['::ffff:808:808', '::ffff:8.8.8.8', '2002:808:808::1', '2001:4860:4860::8888'])
      expect(isBlockedIp(ip), ip).toBe(false);
  });

  it('URL policy checks IPv6 literals (a literal is connected to without any DNS lookup)', () => {
    for (const url of [
      'https://[::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://[::ffff:169.254.169.254]/latest/meta-data/',
      'https://[::ffff:a9fe:a9fe]/latest/meta-data/',
      'https://[fd00:ec2::254]/latest',
      'https://[fe80::1]/x',
    ])
      expect(() => assertSafeUrl(url), url).toThrow(/Blocked/);
    expect(assertSafeUrl('https://[2606:4700:4700::1111]/x').hostname).toBe('[2606:4700:4700::1111]');
  });

  it('a lookup answer with any blocked address is refused as a whole (no picking the public one)', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation(((
      _host: string,
      _opts: unknown,
      cb: (e: null, a: dns.LookupAddress[]) => void,
    ) =>
      cb(null, [
        { address: '93.184.215.14', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ])) as never);
    await expect(
      new Promise((res, rej) => ssrfSafeLookup('mixed.example', {}, (e, a) => (e ? rej(e) : res(a)))),
    ).rejects.toThrow(/Blocked address: mixed.example → 10.0.0.5/);
  });
});

describe('DNS rebinding (spec 18: outbound webhooks and provider calls)', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * A rebinding resolver: the first answer is public (it passes the check), every later answer is the internal
   * target, a loopback fixture server that counts what reaches it. The socket's own `lookup` event reports the
   * address the connection actually used; a public address is aborted right there, so nothing leaves the host.
   */
  async function rebindingHarness() {
    const internal = { hits: 0 };
    const server = http.createServer((_req, res) => {
      internal.hits++;
      res.end('internal');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const answers: string[] = [];
    const resolver = vi.spyOn(dns, 'lookup').mockImplementation(((
      _host: string,
      _opts: unknown,
      cb: (e: null, a: dns.LookupAddress[]) => void,
    ) => {
      const address = answers.length === 0 ? '93.184.215.14' : '127.0.0.1';
      answers.push(address);
      cb(null, [{ address, family: 4 }]);
    }) as never);
    const connectedTo: string[] = [];
    const emit = net.Socket.prototype.emit as (
      this: net.Socket,
      event: string | symbol,
      ...args: unknown[]
    ) => boolean;
    vi.spyOn(net.Socket.prototype, 'emit').mockImplementation(function (
      this: net.Socket,
      event: string | symbol,
      ...args: unknown[]
    ) {
      const handled = emit.call(this, event, ...args);
      if (event === 'lookup' && typeof args[1] === 'string') {
        connectedTo.push(args[1]);
        if (args[1] !== '127.0.0.1') this.destroy(new Error(`test aborted the connection to ${args[1]}`));
      }
      return handled;
    });
    const close = () => new Promise((resolve) => server.close(resolve));
    return { internal, port, answers, resolver, connectedTo, close };
  }

  it('the pinned dispatcher resolves once and connects to the checked (first) address, never the rebound one', async () => {
    const h = await rebindingHarness();
    try {
      const err = await request(`http://rebind.example:${h.port}/hook`, {
        dispatcher: ssrfSafeDispatcher(),
      }).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message).toMatch(/aborted the connection to 93\.184\.215\.14/);
      expect(h.resolver).toHaveBeenCalledTimes(1);
      expect(h.answers).toEqual(['93.184.215.14']);
      expect(h.connectedTo).toEqual(['93.184.215.14']);
      expect(h.internal.hits).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('control: validate-then-connect with an unpinned agent is rebound to the internal target', async () => {
    const h = await rebindingHarness();
    try {
      // What the pinned lookup prevents: a check on one resolution, a connection on another.
      const checked = await new Promise<string>((res, rej) =>
        ssrfSafeLookup('rebind.example', {}, (e, a) => (e ? rej(e) : res(a as string))),
      );
      expect(checked).toBe('93.184.215.14');
      const res = await request(`http://rebind.example:${h.port}/hook`, { dispatcher: new Agent() });
      expect(await res.body.text()).toBe('internal');
      expect(h.answers).toEqual(['93.184.215.14', '127.0.0.1']);
      expect(h.internal.hits).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('a later connection that resolves to the internal address is refused by the same pinned check', async () => {
    const h = await rebindingHarness();
    try {
      const dispatcher = ssrfSafeDispatcher();
      await request(`http://rebind.example:${h.port}/first`, { dispatcher }).catch(() => undefined);
      const err = await request(`http://rebind.example:${h.port}/second`, { dispatcher }).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message ?? '').toMatch(/Blocked address: rebind.example → 127\.0\.0\.1/);
      expect(h.connectedTo).toEqual(['93.184.215.14']);
      expect(h.internal.hits).toBe(0);
    } finally {
      await h.close();
    }
  });
});

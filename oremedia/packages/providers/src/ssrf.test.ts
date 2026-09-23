import { describe, expect, it } from 'vitest';
import { assertSafeUrl, isBlockedIp, ssrfSafeLookup } from './ssrf';

describe('SSRF guard (spec 18, 20.2)', () => {
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
});

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assignVariant, visitorHash } from '@oremedia/contracts/visitor-assignment';
import { createClickBuffer, type ClickRow } from './click-buffer';
import type { ResolvedLink } from './links';
import { createRedirector, redirectTarget } from './server';

/**
 * Spec 15.4 / 16.6 redirector behaviour without a database: the visitor hash is keyed per tenant and day, a plain
 * link redirects to its destination, and the entry link of a running randomised experiment assigns the visitor
 * deterministically with the shared pure function, redirects to the arm and records the click on the arm's link.
 */
const SECRET = 'link-hash-secret';
const experimentLink: ResolvedLink = {
  id: 'tl_entry',
  tenantId: 'ten_A',
  brandId: 'brd_A',
  destination: 'https://brand.example/control?utm_source=oremedia',
  experimentId: 'exp_1',
  arms: [
    {
      trackedLinkId: 'tl_arm_a',
      variantId: 'xv_a',
      destination: 'https://brand.example/a',
      allocationWeight: 1,
    },
    {
      trackedLinkId: 'tl_arm_b',
      variantId: 'xv_b',
      destination: 'https://brand.example/b',
      allocationWeight: 1,
    },
  ],
};
const plainLink: ResolvedLink = {
  id: 'tl_plain',
  tenantId: 'ten_A',
  brandId: 'brd_A',
  destination: 'https://brand.example/plain',
  experimentId: null,
  arms: null,
};

describe('visitor hash (per tenant, per day)', () => {
  it('is stable within a day and tenant, and differs across days, tenants and secrets', () => {
    const d1 = new Date('2026-09-24T10:00:00Z');
    const a = visitorHash(SECRET, 'ten_A', '203.0.113.5|UA', d1);
    expect(a).toBe(visitorHash(SECRET, 'ten_A', '203.0.113.5|UA', new Date('2026-09-24T23:00:00Z')));
    expect(a).not.toBe(visitorHash(SECRET, 'ten_A', '203.0.113.5|UA', new Date('2026-09-25T00:00:00Z')));
    expect(a).not.toBe(visitorHash(SECRET, 'ten_B', '203.0.113.5|UA', d1));
    expect(a).not.toBe(visitorHash('other', 'ten_A', '203.0.113.5|UA', d1));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('203.0.113.5');
  });
});

describe('redirectTarget (spec 16.6 assignment at the redirect)', () => {
  it('assigns deterministically with the shared pure function and spreads visitors over the arms', () => {
    const arms = [
      { id: 'xv_a', allocationWeight: 1 },
      { id: 'xv_b', allocationWeight: 1 },
    ];
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const hash = visitorHash(SECRET, 'ten_A', `198.51.100.${i}|UA`);
      const target = redirectTarget(experimentLink, hash);
      expect(target.variantId).toBe(assignVariant(hash, 'exp_1', arms));
      expect(redirectTarget(experimentLink, hash)).toEqual(target);
      const arm = experimentLink.arms!.find((a) => a.variantId === target.variantId)!;
      expect(target).toEqual({
        trackedLinkId: arm.trackedLinkId,
        destination: arm.destination,
        variantId: arm.variantId,
      });
      seen.add(target.variantId!);
    }
    expect(seen).toEqual(new Set(['xv_a', 'xv_b']));
  });
  it('a plain link, or an experiment that is not running (no arms), goes to its own destination', () => {
    expect(redirectTarget(plainLink, 'h'.repeat(64))).toEqual({
      trackedLinkId: 'tl_plain',
      destination: plainLink.destination,
      variantId: null,
    });
    expect(redirectTarget({ ...experimentLink, arms: null }, 'h'.repeat(64))).toMatchObject({
      trackedLinkId: 'tl_entry',
      destination: experimentLink.destination,
    });
  });
});

describe('GET /<code>', () => {
  const written: ClickRow[] = [];
  const clicks = createClickBuffer({
    write: async (rows) => {
      written.push(...rows);
    },
  });
  const links = new Map([
    ['entry0001', experimentLink],
    ['plain0001', plainLink],
  ]);
  const app = createRedirector({
    resolver: { resolve: async (code) => links.get(code) ?? null },
    clicks,
    hashSecret: SECRET,
    trustProxy: true,
  });
  let base = '';
  let close: () => void = () => undefined;
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        close = () => server.close();
        resolve();
      });
    });
  });
  afterAll(() => close());
  const get = (code: string, ip: string) =>
    fetch(`${base}/${code}`, {
      redirect: 'manual',
      headers: { 'x-forwarded-for': ip, 'user-agent': 'UA-test' },
    });

  it('redirects the same visitor to the same arm and records the exposure on the arm link', async () => {
    const first = await get('entry0001', '203.0.113.7');
    const again = await get('entry0001', '203.0.113.7');
    expect(first.status).toBe(302);
    expect(again.headers.get('location')).toBe(first.headers.get('location'));
    await clicks.flush();
    const hash = visitorHash(SECRET, 'ten_A', '203.0.113.7|UA-test');
    const expected = redirectTarget(experimentLink, hash);
    expect(first.headers.get('location')).toBe(expected.destination);
    expect(written.slice(-2)).toEqual([
      expect.objectContaining({
        trackedLinkId: expected.trackedLinkId,
        visitorHash: hash,
        tenantId: 'ten_A',
      }),
      expect.objectContaining({ trackedLinkId: expected.trackedLinkId, visitorHash: hash }),
    ]);
  });
  it('a plain link redirects to its destination; an unknown code is 404', async () => {
    const res = await get('plain0001', '203.0.113.8');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(plainLink.destination);
    expect((await get('unknown01', '203.0.113.8')).status).toBe(404);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { experimentVariants, experiments } from '@oremedia/db/schema/experiments';
import { linkClicks, trackedLinks } from '@oremedia/db/schema/measurement';
import { visitorHash } from '@oremedia/contracts/visitor-assignment';
import { createClickBuffer } from './click-buffer';
import { createLinkResolver } from './links';
import { redirectTarget } from './server';

/**
 * Spec 16.6 against MySQL 8: the entry link of a running randomised link experiment resolves with its arms (the arm
 * links carrying the experiment variants and their allocation weights); the click the redirector buffers lands on
 * the assigned arm's link, which is how exposures per variant are counted. A stopped experiment has no arms.
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
const code = () => randomUUID().replace(/-/g, '').slice(0, 10);

describe('redirector link resolution for randomised link experiments', () => {
  let tdb: TestDatabase;
  const tenantId = newId('ten');
  const brandId = newId('brd');
  const experimentId = newId('xp');
  const variants = [newId('xv'), newId('xv')].sort();
  const entryCode = code();
  const plainCode = code();
  const armLinkIds = [newId('tl'), newId('tl')];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db
      .insert(tenants)
      .values({ id: tenantId, name: 'R', slug: 'redir-' + tenantId.slice(-8).toLowerCase() });
    await tdb.db
      .insert(brands)
      .values({ id: brandId, tenantId, name: 'R1', timezone: 'UTC', defaultLocale: 'en', status: 'active' });
    await tdb.db.insert(experiments).values({
      id: experimentId,
      tenantId,
      brandId,
      recommendationId: null,
      hypothesis: 'B converts better',
      mode: 'randomised',
      primaryMetricKey: 'qualified_enquiry_rate',
      guardrailMetricKeys: [],
      allocationMethod: 'hashed_visitor',
      minSample: { perArm: 10 },
      observationWindowHours: { hours: 24 },
      stoppingRule: {},
      state: 'running',
      createdByKind: 'user',
      createdById: 'usr_seed',
    });
    await tdb.db.insert(experimentVariants).values(
      variants.map((id, i) => ({
        id,
        tenantId,
        brandId,
        experimentId,
        label: `arm-${i}`,
        contentRevisionId: newId('crv'),
        allocationWeight: i === 0 ? 1 : 3,
      })),
    );
    const link = (
      id: string,
      shortCode: string,
      destination: string,
      experimentVariantId: string | null,
    ) => ({
      id,
      tenantId,
      brandId,
      publicationId: null,
      variantId: null,
      experimentId: shortCode === plainCode ? null : experimentId,
      experimentVariantId,
      destination,
      utm: {},
      shortCode,
    });
    await tdb.db
      .insert(trackedLinks)
      .values([
        link(newId('tl'), entryCode, 'https://brand.example/a?entry', null),
        link(armLinkIds[0]!, code(), 'https://brand.example/a', variants[0]!),
        link(armLinkIds[1]!, code(), 'https://brand.example/b', variants[1]!),
        link(newId('tl'), plainCode, 'https://brand.example/plain', null),
      ]);
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('resolves the entry link with its arms and records each click on the assigned arm link', async () => {
    const resolver = createLinkResolver({ ttlMs: 0 });
    const entry = await resolver.resolve(entryCode, 'corr_redirect');
    expect(entry).toMatchObject({ tenantId, brandId, experimentId });
    expect(entry?.arms).toEqual([
      {
        trackedLinkId: armLinkIds[0],
        variantId: variants[0],
        destination: 'https://brand.example/a',
        allocationWeight: 1,
      },
      {
        trackedLinkId: armLinkIds[1],
        variantId: variants[1],
        destination: 'https://brand.example/b',
        allocationWeight: 3,
      },
    ]);
    expect((await resolver.resolve(plainCode, 'corr_redirect'))?.arms).toBeNull();

    const buffer = createClickBuffer({ write: (rows) => resolver.insertClicks(rows) });
    const expected = new Map<string, number>();
    for (let i = 0; i < 40; i++) {
      const hash = visitorHash('link-secret', tenantId, `192.0.2.${i}|UA`);
      const target = redirectTarget(entry!, hash);
      expected.set(target.trackedLinkId, (expected.get(target.trackedLinkId) ?? 0) + 1);
      buffer.add({
        id: newId('lc'),
        tenantId,
        brandId,
        trackedLinkId: target.trackedLinkId,
        visitorHash: hash,
        occurredAt: new Date(),
      });
    }
    await buffer.stop();
    const stored = await tdb.db.select().from(linkClicks).where(eq(linkClicks.tenantId, tenantId));
    const counted = new Map<string, number>();
    for (const c of stored) counted.set(c.trackedLinkId, (counted.get(c.trackedLinkId) ?? 0) + 1);
    expect(counted).toEqual(expected);
    expect([...counted.keys()].every((id) => armLinkIds.includes(id))).toBe(true);
    expect(counted.get(armLinkIds[1]!)!).toBeGreaterThan(counted.get(armLinkIds[0]!)!); // weights 1:3
  });

  it('a stopped experiment has no arms: everyone goes to the entry destination', async () => {
    await tdb.db.update(experiments).set({ state: 'stopped' }).where(eq(experiments.id, experimentId));
    const entry = await createLinkResolver({ ttlMs: 0 }).resolve(entryCode, 'corr_redirect');
    expect(entry?.arms).toBeNull();
    expect(redirectTarget(entry!, 'h'.repeat(64))).toMatchObject({
      destination: 'https://brand.example/a?entry',
    });
  });
});

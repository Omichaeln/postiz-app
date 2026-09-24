import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ID_PREFIXES, type IdKind } from '@oremedia/contracts/ids';
import { externalReviewerLinks, memberships, sessions, users } from '@oremedia/db/schema/access';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { hashToken } from '@oremedia/module-access';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import {
  CROSS_TENANT_INPUTS,
  callPath,
  seedTwoTenants,
  type SeededTenant,
} from '../../../tooling/test-fixtures/src';
import { allProcedures } from './router';
import { configureRateLimiter } from './trpc';

/** Prefixed ids without the domain package (apps depend on contracts, not domain). */
const newId = (kind: IdKind) =>
  `${ID_PREFIXES[kind]}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
/**
 * Spec 18 (portfolio/export → client data disclosure): an agency user who is a legitimate member of two client
 * companies reads through every query surface (the export surfaces among them: signed media URLs, publication
 * evidence, metric queries, the review manifest) and never receives the other client's rows, whichever company
 * the request selects and whichever ids it passes. A revoked or expired external reviewer link reads nothing.
 */
const EXPORT_SURFACES = [
  'assets.media.signedUrl',
  'publishing.publications.evidence',
  'measurement.metrics.query',
  'review.requests.get',
  'creative.renders.get',
];

describe('mixed-client export disclosure and revoked links (spec 18)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  let agencyToken = '';
  const queries = allProcedures()
    .filter((p) => p.type === 'query')
    .map((p) => p.path)
    .filter((path) => CROSS_TENANT_INPUTS[path]?.buildInput);

  /** Ids of `other` that are its own (a platform row shared by both tenants, e.g. a built-in skill, is not). */
  const ownIds = (other: SeededTenant, self: SeededTenant) =>
    Object.entries(other.ids)
      .filter(([key, value]) => value && self.ids[key] !== value)
      .map(([, value]) => value);
  const leakedIds = (data: unknown, ids: string[]) => {
    const text = JSON.stringify(data ?? null);
    return ids.filter((id) => text.includes(id));
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
    // The agency user: an admin of both client companies (spec 5.1 portfolio = membership projection).
    const userId = newId('user');
    agencyToken = `ses_${randomUUID()}`;
    await tdb.db
      .insert(users)
      .values({ id: userId, email: `agency-${userId.slice(-6).toLowerCase()}@example.test`, name: 'agency' });
    await tdb.db.insert(memberships).values(
      [tenantA, tenantB].map((t) => ({
        id: newId('membership'),
        tenantId: t.tenantId,
        userId,
        role: 'admin' as const,
        status: 'active' as const,
        allBrands: true,
      })),
    );
    await tdb.db.insert(sessions).values({
      id: newId('session'),
      userId,
      tokenHash: hashToken(agencyToken),
      selectedTenantId: tenantA.tenantId,
      expiresAt: new Date(Date.now() + 3600_000),
    });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('covers the export surfaces', () => {
    for (const path of EXPORT_SURFACES) expect(queries, path).toContain(path);
  });

  it('as a member of both clients, every query answers for the selected client only, never with the other client’s rows', async () => {
    const leaks: string[] = [];
    let answered = 0;
    for (const [selected, other] of [
      [tenantA, tenantB],
      [tenantB, tenantA],
    ] as const) {
      const foreign = ownIds(other, selected);
      for (const path of queries) {
        const fixture = CROSS_TENANT_INPUTS[path]!;
        // Own ids: the request succeeds or fails on its own merits, but carries nothing of the other client.
        const own = await callPath(
          { bearer: agencyToken, tenantId: selected.tenantId },
          path,
          fixture.buildInput!(selected.ids),
        );
        if (!own.error) answered++;
        for (const id of leakedIds(own.data, foreign)) leaks.push(`${path} (own ids) returned ${id}`);
        // The other client's ids under this client's selection: refused or empty, and still nothing of theirs.
        const mixed = await callPath(
          { bearer: agencyToken, tenantId: selected.tenantId },
          path,
          fixture.buildInput!(other.ids),
        );
        for (const id of leakedIds(mixed.data, foreign))
          leaks.push(`${path} (other client's ids) returned ${id}`);
        if (!mixed.error && !fixture.expectEmpty) {
          const data = mixed.data as { items?: unknown[] } | unknown[] | null;
          const items = Array.isArray(data) ? data : (data?.items ?? null);
          if (items === null || items.length > 0) leaks.push(`${path} answered for the other client's ids`);
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(answered).toBeGreaterThan(queries.length / 2); // the surfaces really answered for the selected client
  });

  it('a revoked or an expired external reviewer link reads nothing through any query', async () => {
    const answeredFor = async (state: 'revoked' | 'expired') => {
      const token = `rl_${randomUUID()}`;
      await tdb.db.insert(externalReviewerLinks).values({
        id: newId('externalReviewerLink'),
        tenantId: tenantA.tenantId,
        brandId: tenantA.ids['brandId']!,
        reviewRequestId: tenantA.ids['reviewRequestId']!,
        tokenHash: hashToken(token),
        email: `client-${state}@example.test`,
        expiresAt: new Date(Date.now() + (state === 'expired' ? -1000 : 3600_000)),
        revokedAt: state === 'revoked' ? new Date() : null,
        createdByUserId: tenantA.ownerUserId,
      });
      const answered: string[] = [];
      for (const path of ['access.me', 'brand.list', ...queries]) {
        const fixture = CROSS_TENANT_INPUTS[path];
        const input = fixture?.buildInput ? fixture.buildInput(tenantA.ids) : undefined;
        const res = await callPath({ bearer: token, tenantId: tenantA.tenantId }, path, input);
        if (!res.error) answered.push(path);
      }
      return answered;
    };
    expect(await answeredFor('revoked')).toEqual([]);
    expect(await answeredFor('expired')).toEqual([]);
  });
});

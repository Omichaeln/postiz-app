import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  ApprovalInvalidError,
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
  CapabilityUnsupportedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { ChannelVariantForPublishing } from '@oremedia/contracts/publishing';
import type { ReleaseDecision } from '@oremedia/contracts/review';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import {
  channelConnections,
  credentialRefs,
  publicationAttempts,
  publications,
  remoteEvidence,
} from '@oremedia/db/schema/publishing';
import { newId } from '@oremedia/domain/ids';
import { ProviderRegistry, ProviderTransportError } from '@oremedia/providers';
import { configureCredentialBroker, credentialBroker } from './broker';
import { channelService } from './channels';
import { publicationWorkflowId } from './common';
import {
  registerBrandChecker,
  registerProviderClients,
  registerPublishMediaSource,
  registerReleaseEvaluator,
  registerVariantSource,
  registerWorkflowProbe,
  resetReleaseEvaluator,
  resetVariantSource,
  type ReleaseEvaluator,
} from './hooks';
import { LocalKms, WrapOnlyKms } from './kms';
import { configurePublishingProviders } from './providers';
import { publicationService } from './publications';
import { createPublishingRuntime } from './runtime';
import { FIXTURE_PROVIDER_KEY, FixtureProviderAdapter, fixtureCapability } from './testing/fixture-provider';

/**
 * The publishing module against MySQL 8 (spec 14.1, 14.3 control/provider runtime, 14.7, 13.5): channel connect
 * with envelope encryption and the broker's process boundary, the scheduling command (idempotent occurrence,
 * fail-fast release check), the control activities driven in the workflow's order and each called twice (idempotent),
 * the attempt ledger (sentAt before the call, never a second send), crash-after-send reconciliation with exactly one
 * remote post, the cancel race, holds, re-release, disconnect, token refresh and the sweeper.
 */
const USER = 'usr_publishing_test';
const ctx = (tenantId: string, brandIds: ReadonlySet<string> | 'all' = 'all'): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds,
  correlationId: 'corr_publishing',
});
const manager = (tenantId: string): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_publishing_test',
  membershipStatus: 'active',
  role: 'owner',
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));
const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runInTenant(ctx(tenantId), fn);

const kms = new LocalKms('publishing-test-master-secret-0123456789');

describe('publishing module (spec 14) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const A = manager(tenantA);
  const B = manager(tenantB);
  const registry = new ProviderRegistry();
  const fixture = new FixtureProviderAdapter();
  const uncertified = new FixtureProviderAdapter(
    fixtureCapability({ key: 'uncertified_fixture', certifiedAt: null }),
  );
  Object.defineProperty(uncertified, 'key', { value: 'uncertified_fixture' });
  registry.register(fixture).register(uncertified);
  const variantsById = new Map<string, ChannelVariantForPublishing>();
  let releaseDecision: ReleaseDecision = { allow: true };
  const releaseCalls: Array<{ id: string; state: string }> = [];
  let mediaFailure: Error | null = null;
  let runningWorkflows = new Set<string>();
  let connA = '';
  let connB = '';
  const runtime = createPublishingRuntime();
  const recordingEvaluator: ReleaseEvaluator = async (pub) => {
    releaseCalls.push({ id: pub.id, state: pub.state });
    return releaseDecision;
  };

  const wfInput = (publicationId: string, tenantId = tenantA) => ({
    tenantId,
    actor: { kind: 'user' as const, id: USER },
    correlationId: 'corr_publishing',
    publicationId,
  });
  const newVariant = (
    tenantId: string,
    brandId: string,
    channelConnectionId: string,
    text = 'Hello from the fixture',
  ): ChannelVariantForPublishing => {
    const v: ChannelVariantForPublishing = {
      id: newId('channelVariant'),
      tenantId,
      brandId,
      contentPackageId: newId('contentPackage'),
      contentRevisionId: newId('contentRevision'),
      channelConnectionId,
      text,
      altTexts: [],
      settings: {},
      exportIds: [],
      exportHashes: [],
      version: 0,
    };
    variantsById.set(v.id, v);
    return v;
  };
  const schedule = (
    tenantId: string,
    variantId: string,
    at = new Date(Date.now() - 1000),
    occurrence?: string,
  ) =>
    run(tenantId, (tx) =>
      publicationService.schedule(
        manager(tenantId),
        {
          channelVariantId: variantId,
          scheduledFor: at.toISOString(),
          authority: 'approval',
          approvalId: 'apr_test',
          ...(occurrence ? { occurrence } : {}),
        },
        tx,
      ),
    );
  const row = async (id: string) =>
    (await tdb.db.select().from(publications).where(eq(publications.id, id)))[0]!;
  const attemptsOf = (id: string) =>
    tdb.db.select().from(publicationAttempts).where(eq(publicationAttempts.publicationId, id));
  const evidenceOf = (id: string) =>
    tdb.db.select().from(remoteEvidence).where(eq(remoteEvidence.publicationId, id));
  const eventsOf = (tenantId: string, type: string) =>
    tdb.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, tenantId), eq(outboxEvents.eventType, type)));
  const connectionRow = async (id: string) =>
    (await tdb.db.select().from(channelConnections).where(eq(channelConnections.id, id)))[0]!;
  const credentialRow = async (id: string) =>
    (await tdb.db.select().from(credentialRefs).where(eq(credentialRefs.id, id)))[0]!;
  /** The dispatch prefix of spec 14.3 up to the open attempt. */
  const dispatch = async (publicationId: string, claimant = 'pub:wf:run-1') =>
    inTenant(tenantA, async () => {
      const claim = await runtime.control.claimForDispatch({ ...wfInput(publicationId), claimant });
      if (!claim.ok) throw new Error(`claim failed: ${claim.state}`);
      const release = await runtime.control.evaluateRelease({
        ...wfInput(publicationId),
        fencingToken: claim.fencingToken,
      });
      if (!release.allow) throw new Error(`release failed: ${release.reasons.join(',')}`);
      const attemptId = await runtime.control.openAttempt({
        ...wfInput(publicationId),
        fencingToken: claim.fencingToken,
      });
      return { claim, attemptId };
    });
  const connect = async (tenantId: string, brandId: string) => {
    const started = await run(tenantId, (tx) =>
      channelService.connect.start(
        manager(tenantId),
        { brandId, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
        tx,
      ),
    );
    return run(tenantId, (tx) =>
      channelService.connect.complete(manager(tenantId), { state: started.state, code: 'good' }, tx),
    );
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'publishing-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'publishing-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    configurePublishingProviders({ registry });
    configureCredentialBroker({ kms });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    registerBrandChecker({
      assertExist: async (ids) => {
        const known = new Set([brandA, brandB]);
        for (const id of ids) if (!known.has(id)) throw new NotFoundError('Brand', id);
      },
    });
    registerVariantSource(async (id) => {
      const v = variantsById.get(id);
      if (!v) throw new NotFoundError('ChannelVariant', id);
      return v;
    });
    registerReleaseEvaluator(recordingEvaluator);
    registerPublishMediaSource(async () => {
      if (mediaFailure) throw mediaFailure;
      return [];
    });
    registerWorkflowProbe({ isRunning: async (id) => runningWorkflows.has(id) });
    fixture.grant.remoteAccountId = 'acct_A';
    connA = (await connect(tenantA, brandA)).id;
    fixture.grant.remoteAccountId = 'acct_B';
    connB = (await connect(tenantB, brandB)).id;
    fixture.grant.remoteAccountId = 'acct_A';
  });
  afterAll(async () => {
    await tdb?.drop();
  });
  beforeEach(() => {
    fixture.behaviour = { kind: 'accept' };
    fixture.reconcileBehaviour = 'scan';
    releaseDecision = { allow: true };
    mediaFailure = null;
    runningWorkflows = new Set();
  });

  describe('hooks', () => {
    it('fail loudly when the variant source or release evaluator is not registered', async () => {
      resetVariantSource();
      const v = newVariant(tenantA, brandA, connA);
      await expect(schedule(tenantA, v.id)).rejects.toThrow(/variant source not registered/);
      registerVariantSource(async (id) => variantsById.get(id)!);
      resetReleaseEvaluator();
      await expect(schedule(tenantA, v.id)).rejects.toThrow(/release evaluator not registered/);
      registerReleaseEvaluator(recordingEvaluator);
    });
  });

  describe('channel connections and the credential broker (spec 14.7)', () => {
    it('connect sealed the grant: no plaintext in credential_refs, AAD binds tenant and connection, event emitted', async () => {
      const conn = await connectionRow(connA);
      expect(conn.status).toBe('active');
      expect(conn.grantedScopes).toEqual(['w_post']);
      const cred = await credentialRow(conn.credentialRefId);
      expect(cred.aad).toBe(`${tenantA}:${connA}`);
      for (const col of [cred.ciphertext, cred.wrappedDataKey])
        expect(Buffer.from(col, 'base64').toString('utf8')).not.toContain('at_fixture_secret');
      expect(cred.iv).toHaveLength(12);
      expect(JSON.stringify(await eventsOf(tenantA, 'channel.connected'))).not.toContain('at_fixture_secret');
      expect(
        (await eventsOf(tenantA, 'channel.connected')).map((e) => e.payload['channelConnectionId']),
      ).toContain(connA);
      const dto = (await inTenant(tenantA, () => channelService.list(A, { brandId: brandA })))[0]!;
      expect(dto.usable).toBe(true);
      expect(Object.keys(dto)).not.toContain('credentialRefId');
    });

    it('an uncertified provider cannot be connected (registry gate, spec 14.6)', async () => {
      await expect(
        run(tenantA, (tx) =>
          channelService.connect.start(
            A,
            { brandId: brandA, providerKey: 'uncertified_fixture', redirectUri: 'https://app.example/cb' },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
    });

    it('a used or foreign-tenant connect state is refused', async () => {
      const started = await run(tenantA, (tx) =>
        channelService.connect.start(
          A,
          { brandId: brandA, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
          tx,
        ),
      );
      await expect(
        run(tenantB, (tx) => channelService.connect.complete(B, { state: started.state, code: 'good' }, tx)),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      // consumed by the foreign attempt: the owner cannot use it either (one-shot)
      await expect(
        run(tenantA, (tx) => channelService.connect.complete(A, { state: started.state, code: 'good' }, tx)),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });

    it('withCredentials decrypts in a worker, scrubs afterwards, and is NOT_FOUND across tenants', async () => {
      let seen: { accessToken: string } | null = null;
      const out = await inTenant(tenantA, () =>
        credentialBroker.withCredentials(tenantA, connA, async (creds, ref) => {
          seen = creds;
          expect(ref.providerKey).toBe(FIXTURE_PROVIDER_KEY);
          return creds.accessToken;
        }),
      );
      expect(out).toBe('at_fixture_secret');
      expect(seen!.accessToken).toBe(''); // scrubbed after use
      await expect(
        inTenant(tenantA, () => credentialBroker.withCredentials(tenantA, connB, async () => 'x')),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        inTenant(tenantA, () => credentialBroker.withCredentials(tenantB, connB, async () => 'x')),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('the API process (WrapOnlyKms) can seal but never decrypt: credential_decrypt_not_permitted', async () => {
      configureCredentialBroker({ kms: new WrapOnlyKms(kms) });
      try {
        expect(credentialBroker.canDecrypt()).toBe(false);
        await expect(
          inTenant(tenantA, () => credentialBroker.withCredentials(tenantA, connA, async () => 'x')),
        ).rejects.toMatchObject({ reason: 'credential_decrypt_not_permitted' });
        const sealed = await credentialBroker.seal(tenantA, connA, { accessToken: 'x' });
        expect(sealed.aad).toBe(`${tenantA}:${connA}`);
      } finally {
        configureCredentialBroker({ kms });
      }
    });

    it('channelUsable: active with the required scopes; false for a foreign id; false when scopes are missing', async () => {
      expect(await inTenant(tenantA, () => channelService.channelUsable(connA))).toBe(true);
      expect(await inTenant(tenantA, () => channelService.channelUsable(connB))).toBe(false);
      await tdb.db
        .update(channelConnections)
        .set({ grantedScopes: [] })
        .where(eq(channelConnections.id, connA));
      expect(await inTenant(tenantA, () => channelService.channelUsable(connA))).toBe(false);
      await tdb.db
        .update(channelConnections)
        .set({ grantedScopes: ['w_post'] })
        .where(eq(channelConnections.id, connA));
    });

    it('validateVariant runs the adapter against the capability register', async () => {
      const ok = newVariant(tenantA, brandA, connA);
      const long = newVariant(tenantA, brandA, connA, 'x'.repeat(300));
      expect(await inTenant(tenantA, () => channelService.validateVariant(ok.id))).toBe(true);
      expect(await inTenant(tenantA, () => channelService.validateVariantDetailed(long.id))).toMatchObject({
        ok: false,
      });
    });
  });

  describe('scheduling command (spec 14.1)', () => {
    it('an approved variant schedules: row scheduled, outbox event with the stable workflow id, audit, release pre-check recorded', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const at = new Date(Date.now() + 3600_000);
      const pub = await schedule(tenantA, v.id, at);
      expect(pub.state).toBe('scheduled');
      expect(pub.occurrenceKey).toBe(`${v.contentRevisionId}:${connA}:once`);
      expect(releaseCalls.at(-1)).toEqual({ id: 'preview', state: 'scheduled' });
      const evt = (await eventsOf(tenantA, 'publication.scheduled')).find(
        (e) => e.payload['publicationId'] === pub.id,
      )!;
      expect(evt.payload).toMatchObject({
        workflowId: publicationWorkflowId(pub.id, 0),
        rerelease: false,
        scheduledFor: at.toISOString(),
      });
      expect((await row(pub.id)).claimant).toBe(`pub:${pub.id}`);
      const audits = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.resourceId, pub.id)));
      expect(audits.map((a) => a.action)).toContain('publication.schedule');
    });

    it('a repeat with the same occurrence key is CONFLICT and never a second row; a new occurrence is distinct', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const first = await schedule(tenantA, v.id);
      await expect(schedule(tenantA, v.id)).rejects.toBeInstanceOf(ConflictError);
      const again = await schedule(tenantA, v.id, new Date(), 'week-2');
      expect(again.id).not.toBe(first.id);
      const rows = await tdb.db.select().from(publications).where(eq(publications.channelVariantId, v.id));
      expect(rows).toHaveLength(2);
    });

    it('a failed release pre-check is APPROVAL_INVALID with the reasons and writes no row', async () => {
      const v = newVariant(tenantA, brandA, connA);
      releaseDecision = { allow: false, hold: true, reasons: ['approval_matches'] };
      await expect(schedule(tenantA, v.id)).rejects.toMatchObject({ reasons: ['approval_matches'] });
      await expect(schedule(tenantA, v.id)).rejects.toBeInstanceOf(ApprovalInvalidError);
      expect(
        await tdb.db.select().from(publications).where(eq(publications.channelVariantId, v.id)),
      ).toHaveLength(0);
    });

    it("a foreign tenant's variant or channel is NOT_FOUND with no writes", async () => {
      const vB = newVariant(tenantB, brandB, connB);
      const before = (await tdb.db.select().from(publications).where(eq(publications.tenantId, tenantB)))
        .length;
      await expect(schedule(tenantA, vB.id)).rejects.toBeInstanceOf(NotFoundError);
      const crossChannel = newVariant(tenantA, brandA, connB);
      await expect(schedule(tenantA, crossChannel.id)).rejects.toBeInstanceOf(NotFoundError);
      expect(
        (await tdb.db.select().from(publications).where(eq(publications.tenantId, tenantB))).length,
      ).toBe(before);
      await expect(
        inTenant(tenantA, () => publicationService.get(A, { publicationId: newId('publication') })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('an approval authority without an approval id is a validation failure', async () => {
      const v = newVariant(tenantA, brandA, connA);
      await expect(
        run(tenantA, (tx) =>
          publicationService.schedule(
            A,
            { channelVariantId: v.id, scheduledFor: new Date().toISOString(), authority: 'approval' },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });
  });

  describe('dispatch runtime (spec 14.3), every control activity idempotent', () => {
    it('scheduled → dispatching → published with an attempt row, sentAt, remote evidence and the release check recorded', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id);
      expect(await inTenant(tenantA, () => runtime.control.readSchedule(wfInput(pub.id)))).toMatchObject({
        state: 'scheduled',
      });
      const claim = await inTenant(tenantA, () =>
        runtime.control.claimForDispatch({ ...wfInput(pub.id), claimant: 'pub:wf:run-1' }),
      );
      const claimAgain = await inTenant(tenantA, () =>
        runtime.control.claimForDispatch({ ...wfInput(pub.id), claimant: 'pub:wf:run-1' }),
      );
      expect(claim).toEqual({
        ok: true,
        fencingToken: 1,
        providerKey: FIXTURE_PROVIDER_KEY,
        channelConnectionId: connA,
      });
      expect(claimAgain).toEqual(claim); // idempotent per claimant
      expect(
        await inTenant(tenantA, () =>
          runtime.control.claimForDispatch({ ...wfInput(pub.id), claimant: 'pub:wf:run-2' }),
        ),
      ).toEqual({ ok: false, state: 'dispatching' });
      const release = await inTenant(tenantA, () =>
        runtime.control.evaluateRelease({ ...wfInput(pub.id), fencingToken: 1 }),
      );
      expect(release).toEqual({ allow: true });
      expect(releaseCalls.at(-1)).toEqual({ id: pub.id, state: 'dispatching' });
      const attemptId = await inTenant(tenantA, () =>
        runtime.control.openAttempt({ ...wfInput(pub.id), fencingToken: 1 }),
      );
      expect(
        await inTenant(tenantA, () => runtime.control.openAttempt({ ...wfInput(pub.id), fencingToken: 1 })),
      ).toBe(attemptId);
      const opened = (await attemptsOf(pub.id))[0]!;
      expect(opened).toMatchObject({
        attemptNumber: 1,
        fencingToken: 1,
        sentAt: null,
        finishedAt: null,
        providerIdempotencyKey: attemptId,
      });
      const result = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
      );
      expect(result).toMatchObject({ outcome: 'accepted', remotePostId: 'post_1' });
      const sent = (await attemptsOf(pub.id))[0]!;
      expect(sent.sentAt).not.toBeNull();
      expect(sent.finishedAt).not.toBeNull();
      expect(sent.outcome).toBe('accepted');
      const published = await inTenant(tenantA, () =>
        runtime.control.markPublished({ ...wfInput(pub.id), attempt: result }),
      );
      expect(published).toMatchObject({ state: 'published', changed: true });
      expect(
        await inTenant(tenantA, () => runtime.control.markPublished({ ...wfInput(pub.id), attempt: result })),
      ).toMatchObject({ state: 'published', changed: false });
      expect(await row(pub.id)).toMatchObject({
        state: 'published',
        remotePostId: 'post_1',
        remoteUrl: 'https://fixture.example/p/post_1',
      });
      const evidence = await evidenceOf(pub.id);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ kind: 'accepted_response', remotePostId: 'post_1', attemptId });
      const audits = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.resourceId, pub.id)));
      expect(audits.find((a) => a.action === 'publication.release_check')?.decision).toBe('allowed');
      // a repeat publishOnce after the outcome is recorded never re-sends
      const publishCalls = fixture.calls.filter((c) => c === `publish:${attemptId}`).length;
      expect(
        await inTenant(tenantA, () =>
          runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
        ),
      ).toMatchObject({ outcome: 'accepted' });
      expect(fixture.calls.filter((c) => c === `publish:${attemptId}`).length).toBe(publishCalls);
    });

    it('crash after send → outcome_unknown → reconciliation finds the post → published with NO second remote post', async () => {
      const v = newVariant(tenantA, brandA, connA, 'Crash after send caption');
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      fixture.behaviour = { kind: 'crash_after_send' };
      const postsBefore = fixture.posts.length;
      const result = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
      );
      expect(result.outcome).toBe('unknown');
      expect(fixture.posts.length).toBe(postsBefore + 1); // the platform has the post
      const attempt = (await attemptsOf(pub.id))[0]!;
      expect(attempt.sentAt).not.toBeNull();
      expect(attempt.outcome).toBe('unknown');
      expect(
        await inTenant(tenantA, () => runtime.control.markOutcomeUnknown({ ...wfInput(pub.id), attemptId })),
      ).toMatchObject({ state: 'outcome_unknown', changed: true });
      expect(
        await inTenant(tenantA, () => runtime.control.markOutcomeUnknown({ ...wfInput(pub.id), attemptId })),
      ).toMatchObject({ changed: false });
      // a resumed activity after sentAt never re-sends
      fixture.behaviour = { kind: 'accept' };
      expect(
        await inTenant(tenantA, () =>
          runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
        ),
      ).toMatchObject({ outcome: 'unknown' });
      const found = await inTenant(tenantA, () =>
        runtime.provider.findRemotePost({ ...wfInput(pub.id), attemptId }),
      );
      expect(found).toMatchObject({ status: 'found', matchedBy: 'fingerprint' });
      if (found.status !== 'found') throw new Error('unreachable');
      await inTenant(tenantA, () =>
        runtime.control.markPublished({ ...wfInput(pub.id), evidence: { ...found, attemptId } }),
      );
      expect(await row(pub.id)).toMatchObject({ state: 'published', remotePostId: found.remotePostId });
      expect((await evidenceOf(pub.id))[0]).toMatchObject({ kind: 'reconciliation' });
      expect(fixture.posts.length).toBe(postsBefore + 1); // exactly one post, never a duplicate
      expect((await attemptsOf(pub.id))[0]!.remotePostId).toBe(found.remotePostId);
    });

    it('reconciliation that proves absence → retry_eligible; exhausted → held for a human', async () => {
      const v = newVariant(tenantA, brandA, connA, 'Absent caption');
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      fixture.behaviour = { kind: 'after_send_failure' };
      fixture.posts.length = 0;
      expect(
        (
          await inTenant(tenantA, () =>
            runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
          )
        ).outcome,
      ).toBe('unknown');
      fixture.posts.length = 0; // the platform lost it
      await inTenant(tenantA, () => runtime.control.markOutcomeUnknown({ ...wfInput(pub.id), attemptId }));
      expect(
        await inTenant(tenantA, () => runtime.provider.findRemotePost({ ...wfInput(pub.id), attemptId })),
      ).toEqual({ status: 'definitely_absent' });
      expect(await inTenant(tenantA, () => runtime.control.markRetryEligible(wfInput(pub.id)))).toMatchObject(
        { state: 'retry_eligible', changed: true },
      );
      expect(await inTenant(tenantA, () => runtime.control.markRetryEligible(wfInput(pub.id)))).toMatchObject(
        { changed: false },
      );
      // a human re-schedules the same occurrence: a new generation, a new attempt later
      const current = await row(pub.id);
      const released = await run(tenantA, (tx) =>
        publicationService.reschedule(
          A,
          { publicationId: pub.id, expectedVersion: current.version, scheduledFor: new Date().toISOString() },
          tx,
        ),
      );
      expect(released.state).toBe('scheduled');
      const evt = (await eventsOf(tenantA, 'publication.scheduled'))
        .filter((e) => e.payload['publicationId'] === pub.id)
        .at(-1)!;
      expect(evt.payload).toMatchObject({
        rerelease: true,
        workflowId: publicationWorkflowId(pub.id, current.version + 1),
      });
      expect((await row(pub.id)).claimant).toBe(publicationWorkflowId(pub.id, current.version + 1));

      const v2 = newVariant(tenantA, brandA, connA, 'Exhausted caption');
      const pub2 = await schedule(tenantA, v2.id);
      const d2 = await dispatch(pub2.id);
      fixture.reconcileBehaviour = 'cannot_determine';
      await inTenant(tenantA, () =>
        runtime.control.markOutcomeUnknown({ ...wfInput(pub2.id), attemptId: d2.attemptId }),
      );
      expect(
        await inTenant(tenantA, () =>
          runtime.provider.findRemotePost({ ...wfInput(pub2.id), attemptId: d2.attemptId }),
        ),
      ).toMatchObject({ status: 'cannot_determine' });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.holdForHuman({ ...wfInput(pub2.id), reason: 'outcome_unknown_unresolved' }),
        ),
      ).toMatchObject({ state: 'held', changed: true });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.holdForHuman({ ...wfInput(pub2.id), reason: 'outcome_unknown_unresolved' }),
        ),
      ).toMatchObject({ changed: false });
      expect((await row(pub2.id)).holdReasons).toEqual(['outcome_unknown_unresolved']);
    });

    it('a retryable error proven pre-send (no sentAt) goes back to scheduled with a later time; with sentAt it is unknown', async () => {
      const v = newVariant(tenantA, brandA, connA);
      v.exportIds = ['exp_1'];
      v.exportHashes = ['a'.repeat(64)];
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      mediaFailure = new ProviderTransportError(
        Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        'before_send',
      );
      const result = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
      );
      expect(result.outcome).toBe('retryable_error');
      expect((await attemptsOf(pub.id))[0]!.sentAt).toBeNull();
      const before = await row(pub.id);
      const retry = await inTenant(tenantA, () =>
        runtime.control.retryAfterProvenNoEffect({ ...wfInput(pub.id), attempt: result }),
      );
      expect(retry).toMatchObject({ retried: true });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.retryAfterProvenNoEffect({ ...wfInput(pub.id), attempt: result }),
        ),
      ).toEqual(retry); // idempotent
      const after = await row(pub.id);
      expect(after.state).toBe('scheduled');
      expect(after.scheduledFor.getTime()).toBeGreaterThan(before.scheduledFor.getTime());
      // the next claim issues a new fencing token and a second attempt
      mediaFailure = null;
      const second = await dispatch(pub.id, 'pub:wf:run-1');
      expect(second.claim.fencingToken).toBe(2);
      expect((await attemptsOf(pub.id)).map((a) => a.attemptNumber)).toEqual([1, 2]);
      const ok = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId: second.attemptId, fencingToken: 2 }),
      );
      expect(ok.outcome).toBe('accepted');
      // an attempt that was sent cannot be retried
      const sentRetry = await inTenant(tenantA, () =>
        runtime.control.retryAfterProvenNoEffect({
          ...wfInput(pub.id),
          attempt: { ...ok, outcome: 'retryable_error' },
        }),
      );
      expect(sentRetry).toEqual({ retried: false, reason: 'sent' });
      // a stale fencing token is refused
      await expect(
        inTenant(tenantA, () =>
          runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });

    it('rejected → failed; pending → processing → poll (finalize) → published', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      fixture.behaviour = { kind: 'reject', code: 'content_policy' };
      const rejected = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
      );
      expect(rejected).toMatchObject({ outcome: 'rejected', errorCode: 'content_policy' });
      expect(
        await inTenant(tenantA, () => runtime.control.markFailed({ ...wfInput(pub.id), attempt: rejected })),
      ).toMatchObject({ state: 'failed', changed: true });
      expect(
        await inTenant(tenantA, () => runtime.control.markFailed({ ...wfInput(pub.id), attempt: rejected })),
      ).toMatchObject({ changed: false });
      expect((await row(pub.id)).stateReason).toBe('content_policy');

      const v2 = newVariant(tenantA, brandA, connA, 'Pending caption');
      const pub2 = await schedule(tenantA, v2.id);
      const d2 = await dispatch(pub2.id);
      fixture.behaviour = { kind: 'pending' };
      fixture.pendingChecks = ['processing', 'ready'];
      const pending = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub2.id), attemptId: d2.attemptId, fencingToken: 1 }),
      );
      expect(pending.outcome).toBe('pending');
      expect(
        await inTenant(tenantA, () =>
          runtime.control.markProcessing({ ...wfInput(pub2.id), attempt: pending }),
        ),
      ).toMatchObject({ state: 'processing', changed: true });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.markProcessing({ ...wfInput(pub2.id), attempt: pending }),
        ),
      ).toMatchObject({ changed: false });
      const call = { ...wfInput(pub2.id), attemptId: d2.attemptId, fencingToken: 1 };
      expect((await inTenant(tenantA, () => runtime.provider.checkStatus(call))).status).toBe('processing');
      expect((await inTenant(tenantA, () => runtime.provider.checkStatus(call))).status).toBe('ready');
      const done = await inTenant(tenantA, () => runtime.provider.finalize(call));
      expect(done.status).toBe('completed');
      expect((await inTenant(tenantA, () => runtime.provider.checkStatus(call))).status).toBe('completed'); // finalize-already-completed
      if (done.status !== 'completed') throw new Error('unreachable');
      await inTenant(tenantA, () =>
        runtime.control.markPublished({
          ...wfInput(pub2.id),
          attempt: { ...pending, remotePostId: done.remotePostId, remoteUrl: done.remoteUrl },
        }),
      );
      expect(await row(pub2.id)).toMatchObject({ state: 'published', remotePostId: done.remotePostId });
      expect((await evidenceOf(pub2.id))[0]).toMatchObject({ kind: 'status_poll' });
    });

    it('a failed release check at dispatch holds with reasons (dispatching → held), recorded as a denied check', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id);
      releaseDecision = { allow: false, hold: true, reasons: ['approver_still_authorised'] };
      const claim = await inTenant(tenantA, () =>
        runtime.control.claimForDispatch({ ...wfInput(pub.id), claimant: 'pub:wf:run-1' }),
      );
      if (!claim.ok) throw new Error('claim');
      const release = await inTenant(tenantA, () =>
        runtime.control.evaluateRelease({ ...wfInput(pub.id), fencingToken: claim.fencingToken }),
      );
      expect(release).toEqual({ allow: false, reasons: ['approver_still_authorised'] });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.hold({ ...wfInput(pub.id), reasons: ['approver_still_authorised'] }),
        ),
      ).toMatchObject({ state: 'held', changed: true });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.hold({ ...wfInput(pub.id), reasons: ['approver_still_authorised'] }),
        ),
      ).toMatchObject({ changed: false });
      expect((await row(pub.id)).holdReasons).toEqual(['approver_still_authorised']);
      const audits = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.resourceId, pub.id)));
      expect(audits.find((a) => a.action === 'publication.release_check')).toMatchObject({
        decision: 'denied',
      });
      expect(await attemptsOf(pub.id)).toHaveLength(0);
      // a human re-releases: held → scheduled, new generation
      releaseDecision = { allow: true };
      const current = await row(pub.id);
      expect(
        (
          await run(tenantA, (tx) =>
            publicationService.reschedule(
              A,
              {
                publicationId: pub.id,
                expectedVersion: current.version,
                scheduledFor: new Date().toISOString(),
              },
              tx,
            ),
          )
        ).state,
      ).toBe('scheduled');
    });

    it('cross-tenant activity inputs: a foreign publication id, or a tenantId that does not own the row, is NOT_FOUND with no writes (ledger 5.33)', async () => {
      const vB = newVariant(tenantB, brandB, connB);
      const pubB = await schedule(tenantB, vB.id);
      const before = await row(pubB.id);
      await expect(
        inTenant(tenantA, () => runtime.control.claimForDispatch({ ...wfInput(pubB.id), claimant: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        inTenant(tenantA, () => runtime.control.readSchedule(wfInput(pubB.id))),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        inTenant(tenantA, () =>
          runtime.provider.publishOnce({ ...wfInput(pubB.id), attemptId: 'att_x', fencingToken: 1 }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await row(pubB.id)).toEqual(before);
    });
  });

  describe('cancellation (spec 13.5) and rescheduling', () => {
    it('cancel before the claim: scheduled → cancelled with the expected version; a stale version is CONFLICT', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id, new Date(Date.now() + 3600_000));
      await expect(
        run(tenantA, (tx) => publicationService.cancel(A, { publicationId: pub.id, expectedVersion: 7 }, tx)),
      ).rejects.toBeInstanceOf(ConflictError);
      const res = await run(tenantA, (tx) =>
        publicationService.cancel(A, { publicationId: pub.id, expectedVersion: pub.version }, tx),
      );
      expect(res).toEqual({ prevented: true, state: 'cancelled', version: pub.version + 1 });
      expect(await inTenant(tenantA, () => runtime.control.readSchedule(wfInput(pub.id)))).toMatchObject({
        state: 'cancelled',
      }); // the workflow exits
      expect(
        await inTenant(tenantA, () =>
          runtime.control.claimForDispatch({ ...wfInput(pub.id), claimant: 'x' }),
        ),
      ).toEqual({ ok: false, state: 'cancelled' });
    });

    it('cancel during dispatch: { prevented: false } and a cancel_requested event that names the workflow; the signal cancels before the attempt opens', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id);
      const claim = await inTenant(tenantA, () =>
        runtime.control.claimForDispatch({
          ...wfInput(pub.id),
          claimant: `pub:${pub.id}:11111111-2222-3333-4444-555555555555`,
        }),
      );
      if (!claim.ok) throw new Error('claim');
      const res = await run(tenantA, (tx) =>
        publicationService.cancel(A, { publicationId: pub.id, expectedVersion: 0 }, tx),
      );
      expect(res).toEqual({
        prevented: false,
        state: 'dispatching',
        message: 'Dispatch in progress; outcome will be reconciled',
      });
      const evt = (await eventsOf(tenantA, 'publication.cancel_requested')).find(
        (e) => e.payload['publicationId'] === pub.id,
      )!;
      expect(evt.payload['workflowId']).toBe(`pub:${pub.id}`);
      expect((await row(pub.id)).state).toBe('dispatching');
      const cancelled = await inTenant(tenantA, () =>
        runtime.control.releaseClaimAndCancel({ ...wfInput(pub.id), fencingToken: claim.fencingToken }),
      );
      expect(cancelled).toMatchObject({ state: 'cancelled', changed: true });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.releaseClaimAndCancel({ ...wfInput(pub.id), fencingToken: claim.fencingToken }),
        ),
      ).toMatchObject({ changed: false });
      expect(await attemptsOf(pub.id)).toHaveLength(0);
    });

    it('cancelIfNotStarted (the wait-loop cancel) is a no-op once dispatch started, and idempotent otherwise', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id);
      expect(
        await inTenant(tenantA, () => runtime.control.cancelIfNotStarted(wfInput(pub.id))),
      ).toMatchObject({ state: 'cancelled', changed: true });
      expect(
        await inTenant(tenantA, () => runtime.control.cancelIfNotStarted(wfInput(pub.id))),
      ).toMatchObject({ changed: false });
      const v2 = newVariant(tenantA, brandA, connA);
      const pub2 = await schedule(tenantA, v2.id);
      await dispatch(pub2.id);
      expect(
        await inTenant(tenantA, () => runtime.control.cancelIfNotStarted(wfInput(pub2.id))),
      ).toMatchObject({ state: 'dispatching', changed: false });
    });

    it('a published publication cannot be cancelled (policy resource state) and deleteRemote is a separate, recorded action', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      const result = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
      );
      await inTenant(tenantA, () => runtime.control.markPublished({ ...wfInput(pub.id), attempt: result }));
      await expect(
        run(tenantA, (tx) => publicationService.cancel(A, { publicationId: pub.id, expectedVersion: 2 }, tx)),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      const del = await run(tenantA, (tx) =>
        publicationService.deleteRemote(A, { publicationId: pub.id, reason: 'wrong price' }, tx),
      );
      expect(del).toMatchObject({ accepted: true, remotePostId: result.remotePostId });
      expect(
        (await eventsOf(tenantA, 'publication.delete_remote_requested')).some(
          (e) => e.payload['publicationId'] === pub.id,
        ),
      ).toBe(true);
      expect((await row(pub.id)).state).toBe('published'); // never an automatic rollback
    });

    it('reschedule updates the row and emits the reschedule signal for the waiting workflow; it never terminates it', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id, new Date(Date.now() + 3600_000));
      const earlier = new Date(Date.now() + 60_000);
      const res = await run(tenantA, (tx) =>
        publicationService.reschedule(
          A,
          { publicationId: pub.id, expectedVersion: pub.version, scheduledFor: earlier.toISOString() },
          tx,
        ),
      );
      expect(res.scheduledFor).toBe(earlier.toISOString());
      const evt = (await eventsOf(tenantA, 'publication.rescheduled')).find(
        (e) => e.payload['publicationId'] === pub.id,
      )!;
      expect(evt.payload).toMatchObject({ workflowId: `pub:${pub.id}`, scheduledFor: earlier.toISOString() });
      expect((await row(pub.id)).claimant).toBe(`pub:${pub.id}`);
    });

    it('human reconciliation: confirm_published records human evidence; confirm_absent → retry_eligible', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      await inTenant(tenantA, () => runtime.control.markOutcomeUnknown({ ...wfInput(pub.id), attemptId }));
      const done = await run(tenantA, (tx) =>
        publicationService.reconcile(
          A,
          {
            publicationId: pub.id,
            resolution: 'confirm_published',
            remotePostId: 'post_manual',
            remoteUrl: 'https://fixture.example/p/post_manual',
          },
          tx,
        ),
      );
      expect(done).toMatchObject({ state: 'published', remotePostId: 'post_manual' });
      expect((await evidenceOf(pub.id))[0]).toMatchObject({ kind: 'human_confirmation', attemptId });
      const v2 = newVariant(tenantA, brandA, connA);
      const pub2 = await schedule(tenantA, v2.id);
      const d2 = await dispatch(pub2.id);
      await inTenant(tenantA, () =>
        runtime.control.markOutcomeUnknown({ ...wfInput(pub2.id), attemptId: d2.attemptId }),
      );
      expect(
        (
          await run(tenantA, (tx) =>
            publicationService.reconcile(A, { publicationId: pub2.id, resolution: 'confirm_absent' }, tx),
          )
        ).state,
      ).toBe('retry_eligible');
    });
  });

  describe('disconnect, token refresh and the sweeper (spec 14.7, 14.2)', () => {
    it('disconnect destroys the credential (data key gone), disables the connection and holds its scheduled publications', async () => {
      fixture.grant.remoteAccountId = 'acct_A_second';
      const conn2 = await connect(tenantA, brandA);
      fixture.grant.remoteAccountId = 'acct_A';
      const v = newVariant(tenantA, brandA, conn2.id);
      const pub = await schedule(tenantA, v.id, new Date(Date.now() + 3600_000));
      const before = await connectionRow(conn2.id);
      const res = await run(tenantA, (tx) =>
        channelService.disconnect(A, { channelConnectionId: conn2.id, expectedVersion: before.version }, tx),
      );
      expect(res.status).toBe('disabled');
      expect(res.heldPublicationIds).toEqual([pub.id]);
      expect(await row(pub.id)).toMatchObject({ state: 'held', holdReasons: ['channel_active'] });
      const cred = await credentialRow(before.credentialRefId);
      expect(cred.destroyedAt).not.toBeNull();
      expect(cred.ciphertext).toBe('');
      expect(cred.wrappedDataKey).toBe('');
      await expect(
        inTenant(tenantA, () => credentialBroker.withCredentials(tenantA, conn2.id, async () => 'x')),
      ).rejects.toMatchObject({ reason: 'credential_destroyed' });
      expect(await inTenant(tenantA, () => channelService.channelUsable(conn2.id))).toBe(false);
      expect(
        (await eventsOf(tenantA, 'channel.disconnected')).some(
          (e) => e.payload['channelConnectionId'] === conn2.id,
        ),
      ).toBe(true);
      // reconnecting the same remote account rotates the credential and reactivates the connection
      fixture.grant.remoteAccountId = 'acct_A_second';
      const again = await connect(tenantA, brandA);
      fixture.grant.remoteAccountId = 'acct_A';
      expect(again.id).toBe(conn2.id);
      expect(again.status).toBe('active');
      expect((await connectionRow(conn2.id)).credentialRefId).not.toBe(before.credentialRefId);
    });

    it('refreshCredentials writes a new credential row version, destroys the old one, and flags failures', async () => {
      const before = await connectionRow(connA);
      const input = {
        tenantId: tenantA,
        actor: { kind: 'user' as const, id: USER },
        correlationId: 'c',
        channelConnectionId: connA,
      };
      expect(await inTenant(tenantA, () => runtime.tokenRefresh.readRefreshSchedule(input))).toMatchObject({
        status: 'active',
      });
      fixture.refreshBehaviour = {
        ok: true,
        credentials: { accessToken: 'at_refreshed', refreshToken: 'rt_2' },
        tokenExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
      };
      const res = await inTenant(tenantA, () => runtime.tokenRefresh.refreshCredentials(input));
      expect(res).toMatchObject({ ok: true });
      const after = await connectionRow(connA);
      expect(after.credentialRefId).not.toBe(before.credentialRefId);
      expect((await credentialRow(before.credentialRefId)).rotatedAt).not.toBeNull();
      expect((await credentialRow(before.credentialRefId)).ciphertext).toBe('');
      expect(
        await inTenant(tenantA, () =>
          credentialBroker.withCredentials(tenantA, connA, async (c) => c.accessToken),
        ),
      ).toBe('at_refreshed');
      // the per-connection lock: a second refresh inside the lock window is refused
      expect(await inTenant(tenantA, () => runtime.tokenRefresh.refreshCredentials(input))).toEqual({
        ok: false,
        reason: 'locked',
      });
      // a reconnect_required refresh flags the connection and emits the notification event
      const runtime2 = createPublishingRuntime();
      fixture.refreshBehaviour = { ok: false, reason: 'reconnect_required' };
      expect(await inTenant(tenantA, () => runtime2.tokenRefresh.refreshCredentials(input))).toEqual({
        ok: false,
        reason: 'reconnect_required',
      });
      expect((await connectionRow(connA)).status).toBe('reconnect_needed');
      expect(
        (await eventsOf(tenantA, 'channel.reconnect_needed')).some(
          (e) => e.payload['channelConnectionId'] === connA,
        ),
      ).toBe(true);
      expect(await inTenant(tenantA, () => channelService.channelUsable(connA))).toBe(false);
      await tdb.db
        .update(channelConnections)
        .set({ status: 'active' })
        .where(eq(channelConnections.id, connA));
      fixture.refreshBehaviour = {
        ok: true,
        credentials: { accessToken: 'at_refreshed', refreshToken: 'rt_2' },
      };
    });

    it('the sweeper re-emits past-due starts without a running workflow and turns expired claims into outcome_unknown', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const overdue = await schedule(tenantA, v.id, new Date(Date.now() - 10 * 60_000));
      const v2 = newVariant(tenantA, brandA, connA);
      const lost = await schedule(tenantA, v2.id);
      const { attemptId } = await dispatch(lost.id, `pub:${lost.id}:11111111-2222-3333-4444-555555555555`);
      await tdb.db
        .update(publications)
        .set({ claimedAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(publications.id, lost.id));
      const v3 = newVariant(tenantA, brandA, connA);
      const running = await schedule(tenantA, v3.id, new Date(Date.now() - 10 * 60_000));
      runningWorkflows = new Set([`pub:${running.id}`]);
      const sweepInput = {
        correlationId: 'sweep',
        now: new Date().toISOString(),
        claimLeaseSeconds: 20 * 60,
        graceSeconds: 60,
      };
      const summary = await runtime.sweep.sweepPublications(sweepInput);
      expect(summary).toEqual({ scheduledReemitted: 1, dispatchingExpired: 1 });
      expect(
        (await eventsOf(tenantA, 'publication.scheduled')).filter(
          (e) => e.payload['publicationId'] === overdue.id,
        ),
      ).toHaveLength(2);
      expect(
        (await eventsOf(tenantA, 'publication.scheduled')).filter(
          (e) => e.payload['publicationId'] === running.id,
        ),
      ).toHaveLength(1);
      expect(await row(lost.id)).toMatchObject({
        state: 'outcome_unknown',
        stateReason: 'claim_lease_expired',
      });
      expect((await attemptsOf(lost.id))[0]).toMatchObject({ id: attemptId, outcome: 'unknown' });
      const reconcile = (await eventsOf(tenantA, 'publication.reconcile_requested')).find(
        (e) => e.payload['publicationId'] === lost.id,
      )!;
      expect(reconcile.payload).toMatchObject({ attemptId, providerKey: FIXTURE_PROVIDER_KEY });
      // a second pass finds nothing new for the expired claim (outcome_unknown is not swept)
      expect((await runtime.sweep.sweepPublications(sweepInput)).dispatchingExpired).toBe(0);
    });
  });
});

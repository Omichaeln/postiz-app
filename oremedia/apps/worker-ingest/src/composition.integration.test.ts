import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { ModelCompletion, ModelRequest } from '@oremedia/contracts/agents';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { CommentPage } from '@oremedia/contracts/providers';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { messages } from '@oremedia/db/schema/community';
import { customerVoiceClusters } from '@oremedia/db/schema/intelligence';
import { publications } from '@oremedia/db/schema/publishing';
import { configureVoiceClassifier } from '@oremedia/module-intelligence';
import { createCommentIngestionRuntime, resetCommentSinks } from '@oremedia/module-measurement';
import {
  FIXTURE_PROVIDER_KEY,
  FixtureProviderAdapter,
  LocalKms,
  channelService,
  configureCredentialBroker,
  configurePublishingProviders,
  fixtureCapability,
  registerProviderClients,
} from '@oremedia/module-publishing';
import { ProviderRegistry } from '@oremedia/providers';
import { composeModules } from './composition';

/**
 * Spec 16.5 as worker-ingest composes it: a comment pulled by the ingestion runtime (the activity behind
 * commentIngestionWorkflowV1 on `ingest-comments`) is classified by the intelligence module's classifier before the
 * ingesting transaction opens, stored with its classification, and embedded and clustered in the brand's voice
 * library by the sink inside the transaction. The model call and the adapter call see no open transaction.
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
const T0 = new Date('2026-09-24T10:00:00.000Z');

class CommentingFixture extends FixtureProviderAdapter {
  page: CommentPage = { items: [] };
  onFetch: (() => void) | null = null;
  async fetchComments(): Promise<CommentPage> {
    this.onFetch?.();
    return this.page;
  }
}

describe('worker-ingest composition: comment ingestion feeds the customer-voice library (spec 16.5)', () => {
  let tdb: TestDatabase;
  const tenantId = newId('ten');
  const brandId = newId('brd');
  const USER = newId('usr');
  const owner: ResolvedActor = {
    kind: 'user',
    id: USER,
    tenantId,
    membershipId: newId('mem'),
    membershipStatus: 'active',
    role: 'owner',
    allBrands: true,
    brandGrants: [],
    mfaEnrolled: false,
  };
  const ctx: TenantContext = {
    tenantId,
    actor: { kind: 'user', id: USER },
    brandIds: 'all',
    correlationId: 'corr_ingest_voice',
  };
  const run = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(ctx, () => withTransaction(fn));
  const fixture = new CommentingFixture(fixtureCapability({ comments: { read: true, reply: false } }));
  const registry = new ProviderRegistry();
  registry.register(fixture);
  let open = 0;
  const openAtModel: number[] = [];
  const openAtFetch: number[] = [];
  const modelRequests: ModelRequest[] = [];
  let publicationId = '';

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db
      .insert(tenants)
      .values({ id: tenantId, name: 'Ingest', slug: 'ingest-' + tenantId.slice(-8).toLowerCase() });
    await tdb.db.insert(brands).values({
      id: brandId,
      tenantId,
      name: 'Voice',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    composeModules({ COMMENT_AUTHOR_HASH_SECRET_REF: 'ingest-author-secret' });
    // The test platform and key stand in for the provider clients and KMS the worker reads from its environment.
    configurePublishingProviders({ registry });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    configureCredentialBroker({ kms: new LocalKms('ingest-voice-test-master-secret-0123456789') });
    // A scripted model behind the classifier seam (the worker reads its adapter from the environment).
    configureVoiceClassifier({
      adapter: {
        provider: 'anthropic',
        async complete(req: ModelRequest): Promise<ModelCompletion> {
          openAtModel.push(open);
          modelRequests.push(req);
          const part = req.messages[0]?.content[0];
          const body = part?.type === 'text' ? part.text : '';
          return {
            content: [{ type: 'text', text: /\?/.test(body) ? 'question' : 'praise' }],
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: 'end_turn',
          };
        },
      },
      modelId: 'classifier-test-model',
      timeoutMs: 1000,
    });
    const started = await run((tx) =>
      channelService.connect.start(
        owner,
        { brandId, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
        tx,
      ),
    );
    const connection = await run((tx) =>
      channelService.connect.complete(owner, { state: started.state, code: 'good' }, tx),
    );
    publicationId = newId('pub');
    await tdb.db.insert(publications).values({
      id: publicationId,
      tenantId,
      brandId,
      contentPackageId: newId('pkg'),
      contentRevisionId: newId('rev'),
      channelVariantId: newId('var'),
      channelConnectionId: connection.id,
      occurrenceKey: `test:${publicationId}`,
      authority: 'approval',
      approvalId: newId('apr'),
      mandateId: null,
      scheduledFor: T0,
      state: 'published',
      remotePostId: 'post_voice',
      remoteUrl: 'https://fixture.example/p/voice',
      scheduledByKind: 'user',
      scheduledById: USER,
    });
  });
  afterAll(async () => {
    configureVoiceClassifier(null);
    resetCommentSinks();
    await tdb?.drop();
  });

  it('classifies each new comment outside the transaction, stores it and clusters it per brand', async () => {
    const realTransaction = tdb.db.transaction.bind(tdb.db);
    const spy = vi.spyOn(tdb.db, 'transaction').mockImplementation(((
      fn: (tx: Tx) => Promise<unknown>,
      config?: Parameters<typeof realTransaction>[1],
    ) =>
      realTransaction(async (tx) => {
        open += 1;
        try {
          return await fn(tx);
        } finally {
          open -= 1;
        }
      }, config)) as typeof tdb.db.transaction);
    fixture.onFetch = () => openAtFetch.push(open);
    fixture.page = {
      items: [
        {
          remoteCommentId: 'v1',
          authorHandle: '@ann',
          text: 'Do you deliver to Bulawayo on weekends?',
          createdAt: T0.toISOString(),
        },
        {
          remoteCommentId: 'v2',
          authorHandle: '@ben',
          text: 'Do you deliver on weekends to Bulawayo as well?',
          createdAt: new Date(T0.getTime() + 60_000).toISOString(),
        },
      ],
    };
    const ingestion = createCommentIngestionRuntime();
    const pull = (pullIndex: number) =>
      runInTenant(ctx, () =>
        ingestion.pullComments({
          tenantId,
          actor: { kind: 'user', id: USER },
          correlationId: 'corr_ingest_voice',
          publicationId,
          pullIndex,
          since: null,
          cursor: null,
        }),
      );
    try {
      expect(await pull(0)).toEqual({ ingested: 2, duplicates: 0, nextCursor: null });
      // A repeated pull (an activity retry) writes nothing and calls the model for nothing.
      expect(await pull(1)).toEqual({ ingested: 0, duplicates: 2, nextCursor: null });
    } finally {
      spy.mockRestore();
      fixture.onFetch = null;
    }
    expect(openAtFetch).toEqual([0, 0]);
    expect(openAtModel).toEqual([0, 0]);
    expect(modelRequests.map((r) => r.model)).toEqual(['classifier-test-model', 'classifier-test-model']);

    const stored = await tdb.db.select().from(messages).where(eq(messages.tenantId, tenantId));
    expect(stored.map((m) => m.classification)).toEqual(['question', 'question']);
    const clusters = await tdb.db
      .select()
      .from(customerVoiceClusters)
      .where(eq(customerVoiceClusters.tenantId, tenantId));
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ brandId, kind: 'question', size: 2 });
    expect([...clusters[0]!.sampleMessageRefs].sort()).toEqual(stored.map((m) => m.id).sort());
  });
});

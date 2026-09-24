import { describe, expect, it } from 'vitest';
import type {
  CollectionPlanV1,
  CommentIngestionActivitiesV1,
  PullCommentsInputV1,
} from '@oremedia/contracts/measurement';
import {
  COMMENT_PULL_OFFSETS_MS,
  MAX_PAGES_PER_PULL,
  runCommentIngestion,
} from './comment-ingestion.workflow.v1';

const input = {
  tenantId: 'ten_A',
  actor: { kind: 'user' as const, id: 'usr_1' },
  correlationId: 'c',
  publicationId: 'pub_1',
};
const PUBLISHED_AT = Date.parse('2026-09-24T10:00:00.000Z');

function fakes(plan: Partial<CollectionPlanV1> = {}, pagesPerPull = 1) {
  const pulls: PullCommentsInputV1[] = [];
  const sleeps: number[] = [];
  let clock = PUBLISHED_AT;
  const acts: CommentIngestionActivitiesV1 = {
    readCollectionPlan: async () => ({
      collectable: true,
      providerKey: 'fixture_provider',
      publishedAt: new Date(PUBLISHED_AT).toISOString(),
      latencyHours: 1,
      commentsReadable: true,
      ...plan,
    }),
    pullComments: async (i) => {
      pulls.push(i);
      const page = Number(i.cursor ?? '0');
      const more = page + 1 < pagesPerPull;
      return { ingested: 2, duplicates: 0, nextCursor: more ? String(page + 1) : null };
    },
  };
  const host = {
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
  };
  return { acts, host, pulls, sleeps };
}

describe('commentIngestionWorkflowV1 (spec 16.5 read-only ingestion)', () => {
  it('pulls at the comment cadence with cumulative sleeps from the publication moment', async () => {
    const f = fakes();
    expect(await runCommentIngestion(f.acts, input, f.host)).toEqual({
      outcome: 'ingested',
      pulls: 7,
      ingested: 14,
      failed: 0,
    });
    const cumulative = f.sleeps.reduce<number[]>((acc, ms) => [...acc, (acc[acc.length - 1] ?? 0) + ms], []);
    expect(cumulative).toEqual([...COMMENT_PULL_OFFSETS_MS]);
    expect(f.pulls.map((p) => p.pullIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(f.pulls.every((p) => p.since === null && p.cursor === null)).toBe(true);
  });
  it('pages through the adapter cursor within one pull, bounded', async () => {
    const f = fakes({}, 3);
    const outcome = await runCommentIngestion(f.acts, input, f.host);
    expect(outcome.ingested).toBe(7 * 3 * 2);
    expect(f.pulls.slice(0, 3).map((p) => p.cursor)).toEqual([null, '1', '2']);
    const runaway = fakes({}, MAX_PAGES_PER_PULL + 10);
    await runCommentIngestion(runaway.acts, input, runaway.host);
    expect(runaway.pulls.filter((p) => p.pullIndex === 0)).toHaveLength(MAX_PAGES_PER_PULL);
  });
  it('a capability without comment read, or an unpublished publication, ingests nothing', async () => {
    const a = fakes({ commentsReadable: false });
    expect(await runCommentIngestion(a.acts, input, a.host)).toMatchObject({
      outcome: 'comments_not_readable',
    });
    const b = fakes({ collectable: false });
    expect(await runCommentIngestion(b.acts, input, b.host)).toMatchObject({ outcome: 'not_collectable' });
    expect([...a.pulls, ...b.pulls]).toEqual([]);
  });
});

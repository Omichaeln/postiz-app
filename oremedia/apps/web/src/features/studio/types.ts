import type { inferOutput } from '@trpc/tanstack-react-query';
import type { CreativeDocumentV1, Finding, Operation } from '@oremedia/contracts/creative';
import type { IntentBatch, RebaseConflict, TemplateDocument } from '@oremedia/editor';
import type { Trpc } from '../../lib/trpc';
import type { UiError } from '../../lib/errors';

export type DocumentDto = inferOutput<Trpc['creative']['documents']['get']>;
export type RevisionDto = inferOutput<Trpc['creative']['revisions']['get']>;
export type RevisionSummaryDto = inferOutput<Trpc['creative']['revisions']['list']>['items'][number];
export type ApplyResult = inferOutput<Trpc['creative']['operations']['applyBatch']>;
export type ProposeResult = inferOutput<Trpc['creative']['operations']['propose']>;
export type CommentDto = inferOutput<Trpc['creative']['comments']['list']>['items'][number];
export type RenderJobDto = inferOutput<Trpc['creative']['renders']['get']>;
export type TemplateDto = inferOutput<Trpc['creative']['templates']['list']>['items'][number];
export type TemplateDetailDto = inferOutput<Trpc['creative']['templates']['get']>;

/** The committed revision the canvas renders from (spec 21.4); the app owns it, the stage only draws it. */
export interface Committed {
  revisionId: string;
  number: number;
  snapshot: CreativeDocumentV1;
  contentHash: string;
}

/** Local intents not yet sent; one idempotency key per batch, renewed whenever the batch changes. */
export interface PendingBatch {
  operations: Operation[];
  summary: string;
  key: string;
}

export type CommitMode = 'autosave' | 'undo' | 'redo' | 'proposal';

/** A batch on its way to the server. `before` is the committed snapshot it was built on (for undo bookkeeping). */
export interface InFlightBatch extends PendingBatch {
  baseRevisionId: string;
  before: CreativeDocumentV1;
  mode: CommitMode;
  origin: 'user' | 'agent';
}

/** Undo = a new revision applying the inverse (spec 11.4); the entry keeps what is needed to compute it. */
export interface HistoryEntry {
  before: CreativeDocumentV1;
  operations: Operation[];
  summary: string;
}

export type SaveStatus =
  | { kind: 'saved'; at: number }
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'rebasing' }
  | { kind: 'failed'; error: UiError }
  | { kind: 'conflict' };

export interface Conflict {
  head: Committed;
  localOps: Operation[];
  conflicts: RebaseConflict[];
}

/** An agent proposal awaiting Accept / Modify / Reject (spec 11.4, 21.4). */
export interface Proposal {
  id: string;
  batch: IntentBatch;
  baseRevisionId: string;
  result: ProposeResult;
  source: 'agent' | 'simulated';
}

export interface StudioState {
  committed: Committed;
  pending: PendingBatch | null;
  inFlight: InFlightBatch | null;
  save: SaveStatus;
  conflict: Conflict | null;
  proposal: Proposal | null;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  findings: Finding[];
  selection: string[];
  pageId: string;
  /** Resolved template version documents for local reduction of applyTemplate. */
  templates: Record<string, TemplateDocument>;
  /** The last error that is not part of the save status (e.g. an undo that could not be computed). */
  notice: { tone: 'warning' | 'critical' | 'info'; text: string } | null;
}

export const committedOf = (doc: DocumentDto): Committed => ({
  revisionId: doc.revision.id,
  number: doc.revision.number,
  snapshot: doc.revision.snapshot,
  contentHash: doc.revision.contentHash,
});

export const committedOfRevision = (rev: RevisionDto): Committed => ({
  revisionId: rev.id,
  number: rev.number,
  snapshot: rev.snapshot,
  contentHash: rev.contentHash,
});

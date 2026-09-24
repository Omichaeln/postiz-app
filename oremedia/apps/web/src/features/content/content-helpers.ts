import type { Tone } from '@oremedia/ui';

export interface Chip {
  tone: Tone;
  label: string;
  detail?: string;
}

const chipOr = (map: Record<string, Chip>, state: string): Chip =>
  map[state] ?? { tone: 'neutral', label: `Unknown state (${state})` };

/** Spec 6.3 campaign states; every chip is text plus a glyph (spec 21.3). */
export const CAMPAIGN_STATE_CHIP: Record<string, Chip> = {
  draft: { tone: 'neutral', label: 'Draft' },
  active: { tone: 'info', label: 'Active' },
  completed: { tone: 'good', label: 'Completed' },
  archived: { tone: 'neutral', label: 'Archived' },
};
export const campaignChip = (state: string): Chip => chipOr(CAMPAIGN_STATE_CHIP, state);

export const BRIEF_STATE_CHIP: Record<string, Chip> = {
  draft: {
    tone: 'warning',
    label: 'Awaiting acceptance',
    detail: 'Work starts once a person with content.plan accepts the brief.',
  },
  accepted: { tone: 'info', label: 'Accepted', detail: 'The plan is accepted; create a content package.' },
  in_progress: { tone: 'info', label: 'In progress', detail: 'A content package is being produced.' },
  delivered: { tone: 'good', label: 'Delivered' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
};
export const briefChip = (state: string): Chip => chipOr(BRIEF_STATE_CHIP, state);

export const PACKAGE_STATE_CHIP: Record<string, Chip> = {
  draft: { tone: 'neutral', label: 'Draft' },
  in_review: { tone: 'info', label: 'In review' },
  approved: { tone: 'good', label: 'Approved' },
  scheduled: { tone: 'info', label: 'Scheduled' },
  published: { tone: 'good', label: 'Published' },
  archived: { tone: 'neutral', label: 'Archived' },
};
export const packageChip = (state: string): Chip => chipOr(PACKAGE_STATE_CHIP, state);

/** Spec 13.1 content revision machine: draft → in_review → changes_requested | approved → superseded. */
export const REVISION_STATE_CHIP: Record<string, Chip> = {
  draft: { tone: 'neutral', label: 'Draft', detail: 'Not sent for review yet.' },
  in_review: {
    tone: 'info',
    label: 'In review',
    detail: 'Reviewers see the frozen manifest of this revision.',
  },
  changes_requested: {
    tone: 'warning',
    label: 'Changes requested',
    detail: 'A reviewer asked for changes; revise the package to create the next revision.',
  },
  approved: {
    tone: 'good',
    label: 'Approved',
    detail: 'The approval binds exactly this revision; any edit creates a new revision.',
  },
  superseded: {
    tone: 'neutral',
    label: 'Superseded',
    detail: 'A newer revision replaced this one; it is kept as history and never edited.',
  },
};
export const revisionChip = (state: string): Chip => chipOr(REVISION_STATE_CHIP, state);

/** Spec 21.2 "incomplete brief": the fields a brief needs before a plan can be produced from it. */
export function briefGaps(b: {
  audience: string;
  message: string;
  channelConnectionIds: readonly string[];
}): string[] {
  const gaps: string[] = [];
  if (!b.audience.trim()) gaps.push('audience');
  if (!b.message.trim()) gaps.push('message');
  if (b.channelConnectionIds.length === 0) gaps.push('channels');
  return gaps;
}

/** Spec 21.2 "suggested plan": a brief proposed by an agent or a recommendation, not yet accepted by a person. */
export const isSuggested = (b: { createdByKind: string; recommendationId: string | null; state: string }) =>
  b.state === 'draft' && (b.createdByKind !== 'user' || b.recommendationId !== null);

/** Spec 21.2 "missed date": a campaign still open (draft or active) after its end date. */
export const missedDate = (c: { endsAt: string; state: string }, now = new Date()): boolean =>
  (c.state === 'draft' || c.state === 'active') && new Date(c.endsAt).getTime() < now.getTime();

export interface ValidationFindings {
  ok: boolean;
  issues: Array<{ path?: string; issue: string }>;
}

/** A variant's stored capability check, as data (the server stores `{ ok, issues }`). */
export function variantFindings(validation: unknown): ValidationFindings {
  if (typeof validation !== 'object' || validation === null) return { ok: false, issues: [] };
  const v = validation as { ok?: unknown; issues?: unknown };
  const issues = Array.isArray(v.issues)
    ? v.issues
        .filter((i): i is { path?: unknown; issue: unknown } => typeof i === 'object' && i !== null)
        .map((i) => ({
          ...(typeof i.path === 'string' ? { path: i.path } : {}),
          issue: String(i.issue),
        }))
    : [];
  return { ok: v.ok === true, issues };
}

/** The window the planner asks the calendar for packages in: 90 days back to 90 days ahead, at day precision. */
export function packageWindow(now = new Date()): { from: string; to: string } {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    from: new Date(day - 90 * 86_400_000).toISOString(),
    to: new Date(day + 91 * 86_400_000).toISOString(),
  };
}

/** Comma, space or newline separated ids, trimmed and de-duplicated in order. */
export const parseIds = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

/**
 * A content revision pins creative *revisions*, not documents (spec 6.3), so the API cannot say which studio
 * document a package came from. The planner remembers the documents chosen on THIS device per package, as the
 * brand home remembers recent documents; it is a convenience, never presented as the package's record.
 */
const DOCS_KEY = 'oremedia.package_documents';

export function readPackageDocuments(contentPackageId: string): string[] {
  try {
    const raw = localStorage.getItem(DOCS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    return Array.isArray(all[contentPackageId]) ? all[contentPackageId] : [];
  } catch {
    return [];
  }
}

export function rememberPackageDocuments(contentPackageId: string, documentIds: readonly string[]): void {
  try {
    const raw = localStorage.getItem(DOCS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    all[contentPackageId] = [...documentIds];
    localStorage.setItem(DOCS_KEY, JSON.stringify(all));
  } catch {
    // storage blocked: nothing to remember
  }
}

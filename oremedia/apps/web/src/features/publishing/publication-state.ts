import type { Tone } from '@oremedia/ui';
import { PublicationState, type PublicationState as PublicationStateT } from '@oremedia/contracts/publishing';
import type { ChannelConnectionStatus } from '@oremedia/contracts/providers';

export interface StateChip {
  tone: Tone;
  label: string;
  /** What the state means for the person, in one sentence; shown next to the chip in the detail view. */
  detail: string;
}

/** Spec 13.1 publication states, each with text and a tone; colour is never the only carrier (spec 21.3). */
export const PUBLICATION_CHIP: Record<PublicationStateT, StateChip> = {
  scheduled: {
    tone: 'info',
    label: 'Scheduled',
    detail: 'Waiting for its time; can be cancelled or rescheduled.',
  },
  dispatching: {
    tone: 'info',
    label: 'Dispatching',
    detail: 'The workflow has claimed it and is sending it to the channel.',
  },
  processing: {
    tone: 'info',
    label: 'Processing',
    detail: 'The channel accepted it and is still processing; its status is being polled.',
  },
  published: { tone: 'good', label: 'Published', detail: 'The channel confirmed the post.' },
  held: {
    tone: 'warning',
    label: 'Held',
    detail:
      'It will not publish until a person resolves the reasons below (a failed release check, or a restore from backup).',
  },
  failed: { tone: 'critical', label: 'Failed', detail: 'The channel rejected it definitively.' },
  outcome_unknown: {
    tone: 'warning',
    label: 'Outcome unknown',
    detail:
      'The send may or may not have reached the channel (an ambiguous failure after sending, the worker was lost, or it was in flight when the data was restored from a backup). Nothing is retried automatically until the outcome is reconciled, so the post is never duplicated.',
  },
  retry_eligible: {
    tone: 'warning',
    label: 'Retry eligible',
    detail: 'Reconciliation proved the post is absent; it can be released again as a new attempt.',
  },
  cancelled: { tone: 'neutral', label: 'Cancelled', detail: 'Cancelled before dispatch.' },
};

const UNKNOWN_CHIP: StateChip = {
  tone: 'neutral',
  label: 'Unknown state',
  detail: 'The server reported a state this screen does not know.',
};

/** The calendar source types `state` as a string; anything outside the enum is shown as such, never guessed. */
export function publicationChip(state: string): StateChip {
  const parsed = PublicationState.safeParse(state);
  return parsed.success
    ? PUBLICATION_CHIP[parsed.data]
    : { ...UNKNOWN_CHIP, label: `Unknown state (${state})` };
}

/** Spec 13.4 release check keys, explained; the key itself is always shown verbatim next to the text. */
export const HOLD_REASON_TEXT: Record<string, string> = {
  approval_valid: 'The approval is no longer valid.',
  approval_matches: 'The approved package no longer matches what would be published.',
  approval_not_expired: 'The approval expired.',
  approver_still_authorised: 'The approver no longer has review rights on this brand.',
  timing_within_binding: 'The scheduled time is outside the approved timing.',
  mandate_active: 'The mandate is not active.',
  mandate_channel: 'The mandate does not cover this channel.',
  mandate_content_class: 'The mandate does not cover this content class.',
  mandate_daily_quota: 'The mandate reached its daily quota.',
  mandate_sources: 'The content uses sources the mandate does not allow.',
  owner_still_authorised: 'The mandate owner no longer has mandate rights on this brand.',
  kill_switch_off: 'The kill switch is on for this brand.',
  brand_review_clean: 'Brand review found blocking findings.',
  channel_active: 'The channel is not usable (disconnected or needs reconnecting).',
  assets_rights_valid: 'An asset in the package lost its usage rights.',
  facts_valid: 'A fact the copy relies on is no longer valid (an expired offer, for example).',
  capability_valid: 'The variant no longer passes the channel capability check.',
  // Spec 17.6 restore rule (publishing.publications.holdRestored), not a release check: it was never sent.
  restored_from_backup:
    'The data was restored from a backup while this was waiting to be sent; it was never sent. Release it again or cancel it.',
};

export const holdReasonText = (key: string): string =>
  HOLD_REASON_TEXT[key] ?? 'No explanation is recorded for this reason.';

/** Why a publication's outcome is unknown, by its recorded state reason; the key is always shown verbatim too. */
export const OUTCOME_UNKNOWN_REASON_TEXT: Record<string, string> = {
  outcome_unknown: 'The send failed after the request may have reached the channel.',
  claim_lease_expired: 'The worker sending it was lost after the request may have reached the channel.',
  // Spec 17.6 restore rule (publishing.publications.holdRestored): sent before the restore, maybe live already.
  restored_from_backup:
    'The data was restored from a backup after this was sent to the channel, so it may already be live. Look for the post on the channel before anything else.',
};

export const outcomeUnknownReasonText = (key: string | null): string | null =>
  key ? (OUTCOME_UNKNOWN_REASON_TEXT[key] ?? null) : null;

export interface ChannelChip extends StateChip {
  /** True when the channel cannot publish until someone acts (spec 21.2 token expiry). */
  needsAction: boolean;
}

export const CHANNEL_CHIP: Record<ChannelConnectionStatus, ChannelChip> = {
  active: { tone: 'good', label: 'Connected', detail: 'The channel can publish.', needsAction: false },
  refresh_needed: {
    tone: 'warning',
    label: 'Token refresh due',
    detail: 'The access token is about to expire; the refresh workflow is due to renew it.',
    needsAction: false,
  },
  reconnect_needed: {
    tone: 'critical',
    label: 'Needs reconnecting',
    detail:
      'The access token expired or was revoked by the platform; reconnect the channel before publishing.',
    needsAction: true,
  },
  disabled: {
    tone: 'neutral',
    label: 'Disconnected',
    detail: 'The channel was disconnected; scheduled publications on it are held.',
    needsAction: true,
  },
};

/** The states in which the person can act, per spec 13.1 transitions and the publications service. */
export interface PublicationActions {
  cancel: boolean;
  /** Cancel is honoured by the row only before the claim; after it the workflow is signalled (spec 13.5). */
  cancelInFlight: boolean;
  reschedule: boolean;
  /** held / retry_eligible → scheduled: a new attempt of the same occurrence. */
  release: boolean;
  reconcile: boolean;
  deleteRemote: boolean;
}

export function actionsFor(state: string): PublicationActions {
  const parsed = PublicationState.safeParse(state);
  const s = parsed.success ? parsed.data : null;
  const inFlight = s === 'dispatching' || s === 'processing' || s === 'outcome_unknown';
  return {
    cancel: s === 'scheduled' || s === 'held' || inFlight,
    cancelInFlight: inFlight,
    reschedule: s === 'scheduled',
    release: s === 'held' || s === 'retry_eligible',
    reconcile: s === 'outcome_unknown' || s === 'held',
    deleteRemote: s === 'published',
  };
}

/** `YYYY-MM-DD` of an instant in a time zone (the brand's), for grouping and grid lookups. */
export function dayKey(iso: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(typeof iso === 'string' ? new Date(iso) : iso);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Groups by day key, each group ordered by scheduled time. */
export function groupByDay<T extends { scheduledFor: string }>(
  items: readonly T[],
  timeZone: string,
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  const sorted = [...items].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  for (const item of sorted) {
    const key = dayKey(item.scheduledFor, timeZone);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

export type CalendarView = 'month' | 'week';

/** A calendar day as the grid draws it: the key, its number and whether it belongs to the anchor's month. */
export interface GridDay {
  key: string;
  dayOfMonth: number;
  inMonth: boolean;
}

const addDays = (d: Date, n: number): Date => {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
};
const keyOfUtc = (d: Date): string => d.toISOString().slice(0, 10);
/** Monday-first weekday index (0 = Monday). */
const mondayIndex = (d: Date): number => (d.getUTCDay() + 6) % 7;

/** Parses a `YYYY-MM-DD` key into a UTC-midnight date; the grid is drawn in calendar days, not instants. */
export function parseKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

/** Six Monday-first weeks (42 cells) covering the month of `anchorKey`. */
export function monthGrid(anchorKey: string): GridDay[] {
  const anchor = parseKey(anchorKey);
  const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const start = addDays(first, -mondayIndex(first));
  return Array.from({ length: 42 }, (_, i) => {
    const d = addDays(start, i);
    return {
      key: keyOfUtc(d),
      dayOfMonth: d.getUTCDate(),
      inMonth: d.getUTCMonth() === anchor.getUTCMonth(),
    };
  });
}

/** The Monday-first week containing `anchorKey`. */
export function weekDays(anchorKey: string): GridDay[] {
  const anchor = parseKey(anchorKey);
  const start = addDays(anchor, -mondayIndex(anchor));
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(start, i);
    return { key: keyOfUtc(d), dayOfMonth: d.getUTCDate(), inMonth: true };
  });
}

/** Moves the anchor one view-period back or forward. */
export function shiftAnchor(anchorKey: string, view: CalendarView, direction: -1 | 1): string {
  const anchor = parseKey(anchorKey);
  if (view === 'week') return keyOfUtc(addDays(anchor, 7 * direction));
  const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + direction, 1));
  return keyOfUtc(d);
}

/**
 * The instant range a view covers in the brand's time zone: from the first grid day's local midnight to the last
 * grid day's end. Local midnight is found by taking the UTC midnight and correcting by the zone's offset there.
 */
export function rangeFor(
  view: CalendarView,
  anchorKey: string,
  timeZone: string,
): { from: string; to: string } {
  const days = view === 'month' ? monthGrid(anchorKey) : weekDays(anchorKey);
  const firstKey = days[0]?.key ?? anchorKey;
  const lastKey = days[days.length - 1]?.key ?? anchorKey;
  return {
    from: localMidnight(firstKey, timeZone).toISOString(),
    to: new Date(localMidnight(lastKey, timeZone).getTime() + 86_400_000 - 1).toISOString(),
  };
}

/** The instant at which the calendar day `key` starts in `timeZone`. */
export function localMidnight(key: string, timeZone: string): Date {
  const utcMidnight = parseKey(key);
  // Offset = (wall clock at that instant, read as UTC) − the instant.
  const wall = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(utcMidnight);
  const get = (type: string) => Number(wall.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  const offsetMs = asUtc - utcMidnight.getTime();
  return new Date(utcMidnight.getTime() - offsetMs);
}

export interface ChannelOutcomeSummary {
  total: number;
  published: number;
  failed: number;
  held: number;
  unknown: number;
  pending: number;
  cancelled: number;
  /** True when at least one channel published and at least one did not succeed (spec 14.4 partial success). */
  partial: boolean;
  text: string;
}

/** Spec 14.4: each channel is its own publication; the summary names every non-success explicitly. */
export function channelOutcomeSummary(publications: ReadonlyArray<{ state: string }>): ChannelOutcomeSummary {
  const count = (states: string[]) => publications.filter((p) => states.includes(p.state)).length;
  const published = count(['published']);
  const failed = count(['failed']);
  const held = count(['held']);
  const unknown = count(['outcome_unknown', 'retry_eligible']);
  const cancelled = count(['cancelled']);
  const pending = count(['scheduled', 'dispatching', 'processing']);
  const total = publications.length;
  const parts: string[] = [];
  if (published) parts.push(`${published} published`);
  if (failed) parts.push(`${failed} failed`);
  if (held) parts.push(`${held} held`);
  if (unknown) parts.push(`${unknown} with an unknown outcome`);
  if (pending) parts.push(`${pending} pending`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  const partial = published > 0 && published < total - cancelled;
  const text =
    total === 0 ? 'No channels.' : `${parts.join(', ')} of ${total} channel${total === 1 ? '' : 's'}.`;
  return { total, published, failed, held, unknown, pending, cancelled, partial, text };
}

/** `datetime-local` value (local wall clock) → ISO instant; empty or invalid → null. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO instant → `datetime-local` value in the viewer's zone (minutes precision). */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

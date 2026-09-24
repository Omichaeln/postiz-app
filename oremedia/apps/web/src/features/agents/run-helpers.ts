import type { AgentRunState } from '@oremedia/contracts/agents';
import type { Tone } from '@oremedia/ui';
import type { InvocationDto, RunDto, StepDto } from './use-agent-runs';

export interface StateChip {
  tone: Tone;
  label: string;
}

/** Spec 12.2 states as the contract defines them; every chip carries a glyph and a label (spec 21.3). */
export const RUN_STATE_CHIP: Record<AgentRunState, StateChip> = {
  planned: { tone: 'info', label: 'Queued' },
  running: { tone: 'info', label: 'Running' },
  waiting_for_review: { tone: 'warning', label: 'Waiting for review' },
  completed: { tone: 'good', label: 'Completed' },
  failed: { tone: 'critical', label: 'Failed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  budget_exhausted: { tone: 'critical', label: 'Budget exhausted' },
  policy_denied: { tone: 'critical', label: 'Policy denied' },
  waiting_expired: { tone: 'warning', label: 'Review expired' },
};

export const runStateChip = (state: AgentRunState): StateChip => RUN_STATE_CHIP[state];

const TERMINAL: ReadonlySet<AgentRunState> = new Set<AgentRunState>([
  'completed',
  'failed',
  'cancelled',
  'budget_exhausted',
  'policy_denied',
  'waiting_expired',
]);

export const isTerminalState = (state: AgentRunState): boolean => TERMINAL.has(state);

/** Spec 6.1: money is integer micro-units (USD micro-dollars); the UI never shows raw micros. */
export function formatMicros(micros: number, currency = 'USD', locale?: string): string {
  const amount = micros / 1_000_000;
  // Model and tool costs are usually fractions of a cent: below one unit the sub-cent digits are kept.
  const small = amount !== 0 && Math.abs(amount) < 1;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 4 : 2,
  }).format(amount);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

export const formatTokens = (n: number): string => new Intl.NumberFormat().format(n);

export const POLICY_DECISION_TONE: Record<InvocationDto['policyDecision'], Tone> = {
  allowed: 'good',
  denied: 'critical',
  invalid: 'warning',
};

export const OUTCOME_TONE: Record<InvocationDto['outcome'], Tone> = {
  ok: 'good',
  error: 'critical',
  denied: 'critical',
  invalid: 'warning',
  proposal: 'warning',
};

export const STEP_KIND_LABEL: Record<StepDto['kind'], string> = {
  plan: 'Plan',
  model_call: 'Model call',
  tool_call: 'Tool call',
  validation: 'Validation',
};

export interface AttentionItem {
  tone: Tone;
  title: string;
  detail: string;
}

/** The last recorded exception of a run: the newest invocation that errored, or the newest step summary. */
export function recordedException(steps: StepDto[]): string | null {
  const invocations = steps.flatMap((s) => s.invocations);
  const errored = [...invocations].reverse().find((i) => i.outcome === 'error');
  if (errored) return `${errored.toolName}: ${errored.outputRef ?? 'error'}`;
  const last = steps.at(-1);
  return last ? last.summary : null;
}

/**
 * Spec 21.2 "Agent activity" states: waiting, cancelled, budget exhausted, policy denied, recovery required. Every
 * exception and denial is surfaced here with its recorded reason; nothing is inferred from private reasoning.
 */
export function needsAttention(run: RunDto, steps: StepDto[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  const invocations = steps.flatMap((s) => s.invocations);
  const denied = invocations.filter((i) => i.policyDecision === 'denied' || i.outcome === 'denied');
  const invalid = invocations.filter((i) => i.policyDecision === 'invalid' || i.outcome === 'invalid');
  switch (run.state) {
    case 'waiting_for_review':
      items.push({
        tone: 'warning',
        title: 'Waiting for your decision',
        detail:
          'The agent proposed a change and cannot continue until a person accepts, modifies or rejects it. The wait expires after 72 hours.',
      });
      break;
    case 'budget_exhausted':
      items.push({
        tone: 'critical',
        title: 'Budget exhausted',
        detail: `The run stopped when it reached a budget limit (steps, tokens, cost or deadline) after spending ${formatMicros(run.costMicros)}. Raise the limit or start a smaller run.`,
      });
      break;
    case 'policy_denied': {
      const reason = denied.at(-1);
      items.push({
        tone: 'critical',
        title: 'Policy denied',
        detail: reason
          ? `The run ended because ${reason.toolName} was denied: ${reason.policyReason ?? reason.outputRef ?? 'no reason recorded'}.`
          : 'The run ended because an action was denied by policy; the recorded reason is in the timeline.',
      });
      break;
    }
    case 'cancelled':
      items.push({
        tone: 'neutral',
        title: 'Cancelled',
        detail:
          'A person cancelled this run. Its budget reservation was released; nothing further will happen.',
      });
      break;
    case 'failed': {
      const exception = recordedException(steps);
      items.push({
        tone: 'critical',
        title: 'Failed',
        detail: exception
          ? `Recorded exception: ${exception}`
          : 'The run failed before any step was recorded. Start it again or contact support with the run id.',
      });
      break;
    }
    case 'waiting_expired':
      items.push({
        tone: 'warning',
        title: 'Review expired',
        detail:
          'Nobody decided on the proposal within 72 hours, so the run ended. Start a new run to propose again.',
      });
      break;
    default:
      break;
  }
  for (const i of denied)
    if (run.state !== 'policy_denied' || i !== denied.at(-1))
      items.push({
        tone: 'critical',
        title: `Denied: ${i.toolName}`,
        detail: i.policyReason ?? i.outputRef ?? 'No reason recorded',
      });
  for (const i of invalid)
    items.push({
      tone: 'warning',
      title: `Invalid input: ${i.toolName}`,
      detail: 'The tool input failed schema validation and was returned to the model to correct.',
    });
  return items;
}

export interface PendingProposal {
  stepId: string;
  invocation: InvocationDto;
  payload: ProposalPayload;
}

/** The verbatim proposal payload the runtime stored (packages/ai creative.proposeOperations). */
export interface ProposalPayload {
  documentId: string;
  baseRevisionId: string;
  operations: unknown[];
  summary: string;
  findings: Array<{ severity: string; message: string }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function proposalPayloadOf(value: unknown): ProposalPayload | null {
  if (!isRecord(value)) return null;
  if (typeof value['documentId'] !== 'string' || !Array.isArray(value['operations'])) return null;
  return {
    documentId: value['documentId'],
    baseRevisionId: typeof value['baseRevisionId'] === 'string' ? value['baseRevisionId'] : '',
    operations: value['operations'],
    summary: typeof value['summary'] === 'string' ? value['summary'] : '',
    findings: Array.isArray(value['findings'])
      ? value['findings'].filter(isRecord).map((f) => ({
          severity: String(f['severity'] ?? 'info'),
          message: String(f['message'] ?? ''),
        }))
      : [],
  };
}

/** The newest proposal awaiting a decision (the run is in waiting_for_review). */
export function pendingProposal(steps: StepDto[]): PendingProposal | null {
  for (const step of [...steps].reverse())
    for (const invocation of [...step.invocations].reverse())
      if (invocation.outcome === 'proposal' && invocation.proposal !== null) {
        const payload = proposalPayloadOf(invocation.proposal);
        if (payload) return { stepId: step.id, invocation, payload };
      }
  return null;
}

/** The batch a person edits under Modify: what the server validates, minus `origin` (it sets that). */
export const modifyBatchOf = (p: ProposalPayload) =>
  JSON.stringify(
    {
      documentId: p.documentId,
      baseRevisionId: p.baseRevisionId,
      operations: p.operations,
      summary: p.summary,
    },
    null,
    2,
  );

/**
 * The agents router has no runs.list procedure; brand-wide history comes from the audit log (admins) and this
 * per-device list of runs started or opened here fills in for everyone else (the recent-documents precedent).
 */
const RECENT_KEY = 'oremedia.recent_agent_runs';
const RECENT_MAX = 30;

export interface RecentRun {
  companyId: string;
  brandId: string;
  runId: string;
  openedAt: string;
}

export function readRecentRuns(companyId: string, brandId: string): RecentRun[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const all = raw ? (JSON.parse(raw) as RecentRun[]) : [];
    return all.filter((r) => r.companyId === companyId && r.brandId === brandId);
  } catch {
    return [];
  }
}

export function rememberRun(run: Omit<RecentRun, 'openedAt'>): void {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const all = raw ? (JSON.parse(raw) as RecentRun[]) : [];
    const next = [
      { ...run, openedAt: new Date().toISOString() },
      ...all.filter((r) => r.runId !== run.runId),
    ].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: nothing to remember
  }
}

/** Run ids known for a brand, newest first, from the audit log (when readable) and this device. */
export function mergeRunIds(fromAudit: string[], fromDevice: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...fromAudit, ...fromDevice])
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  return out;
}

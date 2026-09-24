import { useEffect, useRef } from 'react';
import { Badge, Button, StatusBanner, type Tone } from '@oremedia/ui';
import type { ElementDiff } from './diff';
import type { Proposal } from './types';

export interface ProposalPanelProps {
  proposal: Proposal;
  diff: ElementDiff[];
  headRevisionId: string;
  hasLocalWork: boolean;
  onAccept: () => void;
  onModify: () => void;
  onReject: () => void;
}

const DIFF_TONE: Record<ElementDiff['kind'], Tone> = {
  added: 'good',
  changed: 'warning',
  removed: 'critical',
};

/** Spec 11.4/21.4: an agent proposal with its diff and findings; Accept commits, Modify loads it as local edits. */
export function ProposalPanel({
  proposal,
  diff,
  headRevisionId,
  hasLocalWork,
  onAccept,
  onModify,
  onReject,
}: ProposalPanelProps) {
  const headingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    headingRef.current?.focus(); // managed focus: a pending proposal is the next thing to decide (spec 21.3)
  }, [proposal.id]);
  const stale = proposal.baseRevisionId !== headRevisionId;
  const blocking = proposal.result.findings.filter((f) => f.severity === 'blocking');
  const acceptReason = proposal.result.blocking
    ? `Blocked by ${blocking.length} finding${blocking.length === 1 ? '' : 's'}; ask for a revised proposal or modify it yourself`
    : stale
      ? 'The document changed since this proposal was made; it needs to be proposed again'
      : hasLocalWork
        ? 'Save your pending changes first'
        : undefined;
  return (
    <div className="flex flex-col gap-3" data-testid="proposal">
      <div
        ref={headingRef}
        tabIndex={-1}
        className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <StatusBanner
          tone={proposal.result.blocking ? 'critical' : 'warning'}
          title="Agent proposal pending"
          description={
            <>
              {proposal.batch.summary}
              {proposal.source === 'simulated' && (
                <Badge tone="info" className="ml-2">
                  Development only
                </Badge>
              )}
            </>
          }
        />
      </div>
      <ul className="flex flex-col gap-1 text-sm" aria-label="Proposed changes">
        {diff.length === 0 && <li className="text-muted-foreground">No visible change.</li>}
        {diff.map((d) => (
          <li key={`${d.kind}-${d.element.id}`} className="flex items-center gap-2">
            <Badge tone={DIFF_TONE[d.kind]}>{d.kind}</Badge>
            <span>{d.element.name}</span>
          </li>
        ))}
      </ul>
      {proposal.result.findings.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Findings">
          {proposal.result.findings.map((f, i) => (
            <li key={i} className="flex items-start gap-2">
              <Badge
                tone={f.severity === 'blocking' ? 'critical' : f.severity === 'warning' ? 'warning' : 'info'}
              >
                {f.severity}
              </Badge>
              <span>{f.message}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" onClick={onAccept} disabledReason={acceptReason}>
          Accept
        </Button>
        <Button size="sm" onClick={onModify}>
          Modify
        </Button>
        <Button size="sm" variant="danger" onClick={onReject}>
          Reject
        </Button>
      </div>
    </div>
  );
}

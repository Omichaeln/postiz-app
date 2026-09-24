import type { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import { Badge, Button, StatusBanner, type Tone } from '@oremedia/ui';
import { Dialog, DialogActions, DialogContent } from '../../components/dialog';
import { retryAfterText } from '../../lib/errors';
import { elementName } from './document-helpers';
import type { Conflict, SaveStatus } from './types';

/** Spec 11.1 visible save/revision state; every state has a glyph and words, never colour alone. */
export function SaveIndicator({
  save,
  revisionNumber,
  onRetry,
}: {
  save: SaveStatus;
  revisionNumber: number;
  onRetry: () => void;
}) {
  const view: { tone: Tone; text: string; busy?: boolean } =
    save.kind === 'saved'
      ? { tone: 'good', text: `Saved · revision ${revisionNumber}` }
      : save.kind === 'pending'
        ? { tone: 'info', text: 'Unsaved changes' }
        : save.kind === 'saving'
          ? { tone: 'info', text: 'Saving…', busy: true }
          : save.kind === 'rebasing'
            ? { tone: 'warning', text: 'Document changed elsewhere; re-applying your changes…', busy: true }
            : save.kind === 'conflict'
              ? { tone: 'critical', text: 'Conflict: needs your decision' }
              : {
                  tone: 'critical',
                  text: `Autosave failed: ${save.error.message}${retryAfterText(save.error.retryAfterMs)}`,
                };
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 text-sm"
      data-testid="save-state"
      data-save-kind={save.kind}
    >
      <Badge tone={view.tone} glyph={!view.busy}>
        {view.busy && (
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent"
          />
        )}
        {view.text}
      </Badge>
      {save.kind === 'failed' && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export interface ConflictDialogProps {
  conflict: Conflict;
  doc: CreativeDocumentV1;
  onKeepServer: () => void;
  onDiscardAll: () => void;
}

/** Spec 21.4: the same element touched by both sides; the person decides, nothing is merged silently. */
export function ConflictDialog({ conflict, doc, onKeepServer, onDiscardAll }: ConflictDialogProps) {
  const names = [
    ...new Set(
      conflict.conflicts.map(
        (c) => elementName(conflict.head.snapshot, c.elementId) || elementName(doc, c.elementId),
      ),
    ),
  ];
  const kept = conflict.localOps.length - conflict.conflicts.length;
  return (
    <Dialog open>
      <DialogContent
        role="alertdialog"
        title="Someone else changed the same elements"
        description={`The document moved to revision ${conflict.head.number} while you were editing. Your changes to ${names.join(', ')} conflict with theirs.`}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <ul
          className="mb-2 flex flex-col gap-1 text-sm"
          aria-label="Conflicting elements"
          data-testid="conflict-list"
        >
          {conflict.conflicts.map((c, i) => (
            <li key={i}>
              <span className="font-medium">
                {elementName(conflict.head.snapshot, c.elementId) || c.elementId}
              </span>
              : you {c.localOp.op}, they {c.remoteOp.op}
            </li>
          ))}
        </ul>
        <StatusBanner
          tone="info"
          title="Nothing is merged silently"
          description={`${Math.max(0, kept)} of your other changes can be re-applied on top of their version.`}
        />
        <DialogActions>
          <Button variant="danger" onClick={onDiscardAll}>
            Discard all my changes
          </Button>
          <Button variant="primary" onClick={onKeepServer} data-testid="conflict-keep-server">
            Keep their version for these elements, re-apply the rest
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

export function LeaveDialog({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onStay()}>
      <DialogContent
        role="alertdialog"
        title="You have unsaved changes"
        description="Leaving now discards local edits that have not been saved yet."
      >
        <DialogActions>
          <Button variant="primary" onClick={onStay}>
            Stay and save
          </Button>
          <Button variant="danger" onClick={onLeave}>
            Leave anyway
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import { Badge, Button, EmptyState, Field, Skeleton, Textarea, type Tone } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { useTRPC } from '../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';
import { useComments } from './use-document';
import { elementName } from './document-helpers';
import type { CommentDto } from './types';

export interface CommentsPanelProps {
  documentId: string;
  revisionId: string;
  doc: CreativeDocumentV1;
  selection: string[];
  /** Element ids the local pending batch touches: their comments will be outdated once saved. */
  pendingElementIds: string[];
  onSelect: (ids: string[]) => void;
}

const TONE: Record<CommentDto['state'], Tone> = { open: 'info', resolved: 'good', outdated: 'warning' };

/** Spec 21.4: element-anchored comments with the "outdated" badge when the element changed after the comment. */
export function CommentsPanel({
  documentId,
  revisionId,
  doc,
  selection,
  pendingElementIds,
  onSelect,
}: CommentsPanelProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const comments = useComments(documentId);
  const [body, setBody] = useState('');
  const selected = selection[0] ?? null;
  const addIntent = useIntentKey();
  const add = useMutation(
    trpc.creative.comments.add.mutationOptions({
      ...mutationIntent(addIntent.key),
      onSuccess: () => {
        addIntent.renew();
        setBody('');
        void queryClient.invalidateQueries(trpc.creative.comments.pathFilter());
      },
    }),
  );
  const resolveIntent = useIntentKey();
  const resolve = useMutation(
    trpc.creative.comments.resolve.mutationOptions({
      ...mutationIntent(resolveIntent.key),
      onSuccess: () => {
        resolveIntent.renew();
        void queryClient.invalidateQueries(trpc.creative.comments.pathFilter());
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (selected && body.trim())
      add.mutate({ documentId, revisionId, elementId: selected, body: body.trim() });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="comments">
      {comments.isPending && <Skeleton label="Loading comments" lines={2} />}
      {comments.isError && <RequestError error={comments.error} onRetry={() => void comments.refetch()} />}
      {comments.isSuccess && comments.data.items.length === 0 && (
        <EmptyState title="No comments" description="Select an element and leave a note for reviewers." />
      )}
      {comments.isSuccess && comments.data.items.length > 0 && (
        <ul className="flex flex-col divide-y divide-border text-sm">
          {comments.data.items.map((c) => (
            <li key={c.id} className="flex flex-col gap-1 py-2">
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  className="font-medium underline-offset-2 hover:underline"
                  onClick={() => onSelect([c.elementId])}
                >
                  {elementName(doc, c.elementId)}
                </button>
                <Badge tone={TONE[c.state]}>
                  {c.state === 'outdated' ? 'Outdated: element changed' : c.state}
                </Badge>
                {c.state === 'open' && pendingElementIds.includes(c.elementId) && (
                  <Badge tone="warning">Will be outdated when saved</Badge>
                )}
                <span className="text-xs text-muted-foreground">{c.authorKind}</span>
              </div>
              <p>{c.body}</p>
              {c.state !== 'resolved' && (
                <div>
                  <Button
                    size="sm"
                    onClick={() =>
                      resolve.mutate({ documentId, commentId: c.id, expectedVersion: c.version })
                    }
                    disabled={resolve.isPending}
                  >
                    Resolve
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {resolve.isError && <RequestError error={resolve.error} />}
      <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border pt-3" noValidate>
        <Field
          label={selected ? `Comment on ${elementName(doc, selected)}` : 'Comment'}
          htmlFor="comment-body"
          hint={selected ? undefined : 'Select an element to anchor the comment.'}
          error={add.isError ? toUiError(add.error).message : undefined}
        >
          <Textarea
            id="comment-body"
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={!selected}
            maxLength={5000}
          />
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={!selected || !body.trim() || add.isPending}>
            Add comment
          </Button>
        </div>
      </form>
    </div>
  );
}

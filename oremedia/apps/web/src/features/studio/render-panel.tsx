import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Badge, Button, EmptyState, StatusBanner } from '@oremedia/ui';
import { useTRPC } from '../../lib/trpc';
import { intentContext, useIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';
import { useRenderJob } from './use-document';

export interface RenderPanelProps {
  documentId: string;
  revisionId: string;
  formatKey: string;
  hasLocalWork: boolean;
}

/** Spec 11.5: a render is requested for a committed revision; the worker moves the job; failures are shown, not hidden. */
export function RenderPanel({ documentId, revisionId, formatKey, hasLocalWork }: RenderPanelProps) {
  const trpc = useTRPC();
  const intent = useIntentKey();
  const [jobId, setJobId] = useState<string | null>(null);
  const request = useMutation(
    trpc.creative.renders.request.mutationOptions({
      ...intentContext(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setJobId(res.renderJobId);
      },
    }),
  );
  const job = useRenderJob(jobId);
  return (
    <div className="flex flex-col gap-2" data-testid="render">
      <Button
        size="sm"
        onClick={() => request.mutate({ documentId, revisionId, formatKeys: [formatKey] })}
        disabled={request.isPending}
        disabledReason={
          hasLocalWork
            ? 'Save your pending changes first; renders are made from a committed revision'
            : undefined
        }
      >
        Render this page
      </Button>
      {request.isError && (
        <StatusBanner
          tone="critical"
          title="Render request failed"
          description={toUiError(request.error).message}
        />
      )}
      {jobId && job.isError && (
        <StatusBanner
          tone="critical"
          title="Cannot read the render job"
          description={toUiError(job.error).message}
        />
      )}
      {jobId && job.data && (job.data.state === 'pending' || job.data.state === 'rendering') && (
        <StatusBanner
          tone="info"
          busy
          title={job.data.state === 'pending' ? 'Render queued' : 'Rendering…'}
          description="The render worker picks the job up from the outbox; this page refreshes every two seconds."
        />
      )}
      {jobId && job.data?.state === 'failed' && (
        <StatusBanner
          tone="critical"
          title="Render failed"
          description={job.data.error ?? 'The worker reported a failure without detail.'}
          actions={
            <Button
              size="sm"
              onClick={() => request.mutate({ documentId, revisionId, formatKeys: [formatKey] })}
            >
              Retry
            </Button>
          }
        />
      )}
      {jobId && job.data?.state === 'ready' && (
        <div className="flex flex-col gap-1 text-sm">
          <StatusBanner
            tone="good"
            title="Render ready"
            description={`${job.data.exports.length} export${job.data.exports.length === 1 ? '' : 's'}; the export hash is what review and publishing bind to.`}
          />
          <ul className="flex flex-col gap-1">
            {job.data.exports.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2">
                <Badge glyph={false}>{e.formatKey}</Badge>
                <span>
                  {e.width}×{e.height} {e.mime} {Math.round(e.bytes / 1024)} kB
                </span>
                <code className="text-xs">{e.contentHash.slice(0, 12)}…</code>
                {!e.validation.ok && <Badge tone="warning">Checks found issues</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!jobId && !request.isError && (
        <EmptyState
          title="No render requested"
          description="Renders are produced by the render worker from the committed revision."
          className="py-4"
        />
      )}
    </div>
  );
}

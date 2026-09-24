import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  PublicationAuthority,
  type PublicationAuthority as PublicationAuthorityT,
} from '@oremedia/contracts/publishing';
import { Badge, Button, Field, Input, Panel, Skeleton, StatusBanner } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { useToast } from '../../components/toast';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';
import { useTRPC } from '../../lib/trpc';
import { CHANNEL_CHIP, dayKey, isoToLocalInput, localInputToIso } from './publication-state';
import { useChannelVariant, type ChannelDto } from './use-publishing';

export interface ScheduleFormProps {
  timeZone: string;
  channels: ReadonlyMap<string, ChannelDto>;
  /** Called with the scheduled instant's day key so the calendar shows it. */
  onScheduled: (publicationId: string, dayKey: string) => void;
}

/**
 * Spec 14.1: schedule a channel variant with an authority. The variant is loaded first so the person sees the
 * channel it targets, that channel's connection state (token expiry, spec 21.2) and the variant's validation
 * findings (invalid media) before anything is scheduled; the API re-checks all of it (fail-fast pre-check).
 */
export function ScheduleForm({ timeZone, channels, onScheduled }: ScheduleFormProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [variantDraft, setVariantDraft] = useState('');
  const [variantId, setVariantId] = useState<string | null>(null);
  const [at, setAt] = useState(() => isoToLocalInput(new Date(Date.now() + 60 * 60_000).toISOString()));
  const [authority, setAuthority] = useState<PublicationAuthorityT>('approval');
  const [authorityId, setAuthorityId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const variant = useChannelVariant(variantId);
  const channel = variant.data ? channels.get(variant.data.channelConnectionId) : undefined;
  const findings = variant.data?.validation as
    { ok: boolean; issues: Array<{ path?: string; issue: string }> } | undefined;
  const intent = useIntentKey();
  const schedule = useMutation(
    trpc.publishing.publications.schedule.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res, vars) => {
        intent.renew();
        setError(null);
        void queryClient.invalidateQueries(trpc.content.calendar.pathFilter());
        void queryClient.invalidateQueries(trpc.publishing.publications.pathFilter());
        toast({
          tone: 'good',
          title: 'Scheduled',
          description: `Publication ${res.id} for ${new Date(vars.scheduledFor).toLocaleString()}.`,
        });
        onScheduled(res.id, dayKey(vars.scheduledFor, timeZone));
      },
      onError: (err) => setError(toUiError(err).message),
    }),
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!variantId) {
      setError('Load a channel variant first.');
      return;
    }
    const iso = localInputToIso(at);
    if (!iso) {
      setError('Enter a date and time.');
      return;
    }
    if (!authorityId.trim()) {
      setError(authority === 'approval' ? 'An approval id is required.' : 'A mandate id is required.');
      return;
    }
    setError(null);
    schedule.mutate({
      channelVariantId: variantId,
      scheduledFor: iso,
      authority,
      ...(authority === 'approval' ? { approvalId: authorityId.trim() } : { mandateId: authorityId.trim() }),
    });
  };

  const blocked = findings ? !findings.ok : false;
  const channelBlocked = channel ? !channel.usable : false;

  return (
    <Panel title="Schedule a publication">
      <form
        className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setVariantId(variantDraft.trim() || null);
        }}
      >
        <Field
          label="Channel variant id"
          htmlFor="schedule-variant"
          className="flex-1"
          hint="cv_… (from the content package)"
        >
          <Input
            id="schedule-variant"
            value={variantDraft}
            onChange={(e) => setVariantDraft(e.target.value)}
          />
        </Field>
        <Button type="submit">Load variant</Button>
      </form>
      {variantId !== null && variant.isPending && <Skeleton label="Loading variant" lines={2} />}
      {variantId !== null && variant.isError && (
        <RequestError error={variant.error} onRetry={() => void variant.refetch()} />
      )}
      {variant.isSuccess && (
        <div className="flex flex-col gap-3" data-testid="variant-preview">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>Channel:</span>
            {channel ? (
              <Badge
                tone={CHANNEL_CHIP[channel.status].tone}
                glyph={CHANNEL_CHIP[channel.status].tone !== 'good'}
              >
                {channel.displayName} ({channel.providerKey}): {CHANNEL_CHIP[channel.status].label}
              </Badge>
            ) : (
              <code>{variant.data.channelConnectionId}</code>
            )}
          </div>
          <p className="line-clamp-3 rounded-md border border-border bg-muted p-2 text-sm">
            {variant.data.text}
          </p>
          {channel && channelBlocked && (
            <StatusBanner
              tone={CHANNEL_CHIP[channel.status].tone}
              title={`${channel.displayName}: ${CHANNEL_CHIP[channel.status].label}`}
              description={
                <>
                  {CHANNEL_CHIP[channel.status].detail}
                  {channel.tokenExpiresAt &&
                    ` Token expired ${new Date(channel.tokenExpiresAt).toLocaleString()}.`}{' '}
                  Scheduling would be held at dispatch with reason <code>channel_active</code>; reconnect the
                  channel under Settings first.
                </>
              }
            />
          )}
          {findings && !findings.ok && (
            <StatusBanner
              tone="critical"
              title="Invalid media: this variant does not pass the channel's capability check"
              description={
                <ul className="list-disc pl-5" data-testid="variant-findings">
                  {findings.issues.map((i, n) => (
                    <li key={n}>
                      {i.path && <code className="text-xs">{i.path}</code>} {i.issue}
                    </li>
                  ))}
                </ul>
              }
            />
          )}
          {findings?.ok && (
            <p className="text-xs text-muted-foreground">
              Capability check passed for capability version {String(variant.data.capabilityVersion)}.
            </p>
          )}
          <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Publish at" htmlFor="schedule-at">
                <Input
                  id="schedule-at"
                  type="datetime-local"
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                  required
                />
              </Field>
              <Field label="Authority" htmlFor="schedule-authority">
                <Select
                  id="schedule-authority"
                  value={authority}
                  onValueChange={(v) => setAuthority(PublicationAuthority.parse(v))}
                  options={[
                    { value: 'approval', label: 'Approval' },
                    { value: 'mandate', label: 'Mandate' },
                  ]}
                />
              </Field>
              <Field
                label={authority === 'approval' ? 'Approval id' : 'Mandate id'}
                htmlFor="schedule-authority-id"
              >
                <Input
                  id="schedule-authority-id"
                  value={authorityId}
                  onChange={(e) => setAuthorityId(e.target.value)}
                  required
                />
              </Field>
            </div>
            {error && <StatusBanner tone="critical" title="Not scheduled" description={error} />}
            <div>
              <Button
                type="submit"
                variant="primary"
                disabled={schedule.isPending}
                disabledReason={
                  blocked
                    ? 'Fix the validation findings first'
                    : channelBlocked
                      ? 'Reconnect the channel first'
                      : undefined
                }
              >
                {schedule.isPending ? 'Scheduling…' : 'Schedule'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </Panel>
  );
}

import { Link } from 'react-router';
import { Button, StatusBanner } from '@oremedia/ui';
import { CHANNEL_CHIP } from './publication-state';
import type { ChannelDto } from './use-publishing';

/** Spec 21.2 token expiry: every channel that cannot publish is named with why and where to fix it. */
export function ChannelStatus({
  channels,
  settingsHref,
}: {
  channels: readonly ChannelDto[];
  settingsHref: string;
}) {
  const needing = channels.filter((c) => CHANNEL_CHIP[c.status].needsAction);
  if (needing.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="channel-status">
      {needing.map((c) => {
        const chip = CHANNEL_CHIP[c.status];
        return (
          <StatusBanner
            key={c.id}
            tone={chip.tone}
            title={`${c.displayName} (${c.providerKey}): ${chip.label}`}
            description={
              <>
                {chip.detail}
                {c.tokenExpiresAt && ` Token expired ${new Date(c.tokenExpiresAt).toLocaleString()}.`}
                {c.missingScopes.length > 0 && ` Missing scopes: ${c.missingScopes.join(', ')}.`} Publications
                scheduled on it are held with reason <code>channel_active</code> until it is reconnected.
              </>
            }
            actions={
              <Button size="sm" asChild>
                <Link to={settingsHref}>Open settings</Link>
              </Button>
            }
          />
        );
      })}
    </div>
  );
}

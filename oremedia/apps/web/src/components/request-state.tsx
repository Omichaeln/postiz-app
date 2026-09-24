import * as React from 'react';
import { Navigate } from 'react-router';
import { Button, StatusBanner, type Tone } from '@oremedia/ui';
import { retryAfterText, signInHref, toUiError, type UiError } from '../lib/errors';

const TONE: Record<UiError['kind'], Tone> = {
  sign_in: 'info',
  forbidden: 'warning',
  not_found: 'warning',
  rate_limited: 'warning',
  stale_revision: 'warning',
  validation: 'critical',
  conflict: 'warning',
  rights: 'warning',
  network: 'critical',
  other: 'critical',
};

const TITLE: Record<UiError['kind'], string> = {
  sign_in: 'Sign in required',
  forbidden: 'Restricted access',
  not_found: 'Not found',
  rate_limited: 'Too many requests',
  stale_revision: 'The document changed',
  validation: 'The request was not accepted',
  conflict: 'Something changed in the meantime',
  rights: 'Not eligible',
  network: 'Cannot reach the server',
  other: 'Something went wrong',
};

export interface RequestErrorProps {
  error: unknown;
  onRetry?: () => void;
  /** Override the title (e.g. "Restricted access: this company is not in your portfolio"). */
  title?: string;
  className?: string;
}

/** One rendering for every request failure; UNAUTHENTICATED becomes the sign-in route (spec 7.2 branch on code). */
export function RequestError({ error, onRetry, title, className }: RequestErrorProps) {
  const ui = toUiError(error);
  if (ui.kind === 'sign_in') return <Navigate to={signInHref()} replace />;
  return (
    <StatusBanner
      tone={TONE[ui.kind]}
      title={title ?? TITLE[ui.kind]}
      className={className}
      data-error-code={ui.code}
      description={
        <>
          <span>
            {ui.message}
            {retryAfterText(ui.retryAfterMs)}
          </span>
          {ui.details.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {ui.details.map((d, i) => (
                <li key={i}>
                  {d.path ? <code className="text-xs">{d.path}</code> : null} {d.issue}
                </li>
              ))}
            </ul>
          )}
          {ui.correlationId && (
            <span className="mt-1 block text-xs">
              Reference <code>{ui.correlationId}</code>
            </span>
          )}
        </>
      }
      actions={
        onRetry && (
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        )
      }
    />
  );
}

/** Wraps the page title so every route announces itself consistently. */
export function PageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

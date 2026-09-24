import * as React from 'react';
import { cn } from './cn';
import { toneBorderClass, toneGlyph, toneTextClass, type Tone } from './badge';

export interface StatusBannerProps extends React.HTMLAttributes<HTMLDivElement> {
  tone: Tone;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Critical banners interrupt (role=alert); everything else is polite (role=status). */
  live?: 'assertive' | 'polite';
  /** Show a spinner glyph (in-progress states). */
  busy?: boolean;
}

/** Status is carried by glyph + text + role, never by colour alone (spec 21.3). */
export const StatusBanner = React.forwardRef<HTMLDivElement, StatusBannerProps>(function StatusBanner(
  { tone, title, description, actions, live, busy, className, ...props },
  ref,
) {
  const assertive = live ? live === 'assertive' : tone === 'critical';
  return (
    <div
      ref={ref}
      role={assertive ? 'alert' : 'status'}
      aria-busy={busy || undefined}
      className={cn(
        'flex items-start gap-3 rounded-md border-l-4 border border-border bg-muted px-3 py-2 text-sm',
        toneBorderClass[tone],
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs font-bold',
          toneBorderClass[tone],
          toneTextClass[tone],
          busy && 'animate-spin border-dashed',
        )}
      >
        {busy ? '' : toneGlyph[tone]}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{title}</p>
        {description && <div className="mt-0.5 text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
});

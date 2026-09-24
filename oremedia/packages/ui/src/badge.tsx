import * as React from 'react';
import { cn } from './cn';

export type Tone = 'neutral' | 'good' | 'warning' | 'critical' | 'info';

/** Every tone has a glyph so colour is never the only carrier of status (spec 21.3). */
export const toneGlyph: Record<Tone, string> = {
  neutral: '•',
  good: '✓',
  warning: '!',
  critical: '✕',
  info: 'i',
};

export const toneTextClass: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  good: 'text-status-good',
  warning: 'text-status-warning',
  critical: 'text-status-critical',
  info: 'text-status-info',
};

export const toneBorderClass: Record<Tone, string> = {
  neutral: 'border-border',
  good: 'border-status-good',
  warning: 'border-status-warning',
  critical: 'border-status-critical',
  info: 'border-status-info',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Hide the glyph when the text itself is the status (e.g. "Locked"). */
  glyph?: boolean;
}

export function Badge({ tone = 'neutral', glyph = true, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-xs font-medium leading-4',
        toneBorderClass[tone],
        toneTextClass[tone],
        className,
      )}
      {...props}
    >
      {glyph && <span aria-hidden="true">{toneGlyph[tone]}</span>}
      {children}
    </span>
  );
}

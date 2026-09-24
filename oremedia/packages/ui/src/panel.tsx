import * as React from 'react';
import { cn } from './cn';

export interface PanelProps extends React.HTMLAttributes<HTMLElement> {
  /** Accessible name of the region; rendered as the heading unless `hideTitle`. */
  title: string;
  hideTitle?: boolean;
  actions?: React.ReactNode;
  /** Heading level for the document outline. */
  level?: 2 | 3 | 4;
  bodyClassName?: string;
}

/** A labelled region (`<section aria-labelledby>`), the building block of every screen. */
export const Panel = React.forwardRef<HTMLElement, PanelProps>(function Panel(
  { title, hideTitle, actions, level = 2, className, bodyClassName, children, id, ...props },
  ref,
) {
  const generated = React.useId();
  const headingId = `${id ?? generated}-heading`;
  const Heading = `h${level}` as const;
  return (
    <section
      ref={ref}
      id={id}
      aria-labelledby={headingId}
      className={cn('flex min-h-0 flex-col rounded-md border border-border bg-background', className)}
      {...props}
    >
      <div
        className={cn(
          'flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2',
          hideTitle && !actions && 'sr-only',
        )}
      >
        <Heading id={headingId} className={cn('text-sm font-semibold', hideTitle && 'sr-only')}>
          {title}
        </Heading>
        {actions && <div className="flex items-center gap-1">{actions}</div>}
      </div>
      <div className={cn('min-h-0 flex-1 overflow-auto p-3', bodyClassName)}>{children}</div>
    </section>
  );
});

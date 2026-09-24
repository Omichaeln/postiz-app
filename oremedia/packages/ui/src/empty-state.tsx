import * as React from 'react';
import { cn } from './cn';

export interface EmptyStateProps {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}

/** An honest empty or not-yet-available state: what is missing and what the person can do about it. */
export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border px-6 py-10 text-center',
        className,
      )}
    >
      {icon && (
        <div aria-hidden="true" className="text-2xl text-muted-foreground">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description && <div className="max-w-md text-sm text-muted-foreground">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

import * as React from 'react';
import { cn } from './cn';

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** What is loading, announced once to assistive technology. */
  label?: string;
  lines?: number;
}

export function Skeleton({ label = 'Loading', lines = 3, className, ...props }: SkeletonProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn('flex flex-col gap-2', className)}
      {...props}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="h-3 animate-pulse rounded-md bg-muted"
          style={{ width: `${100 - (i % 3) * 15}%` }}
        />
      ))}
    </div>
  );
}

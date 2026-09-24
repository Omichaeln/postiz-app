import * as React from 'react';
import * as RadixTabs from '@radix-ui/react-tabs';
import { cn } from '@oremedia/ui';

export const Tabs = RadixTabs.Root;

export function TabList({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <RadixTabs.List
      aria-label={label}
      className={cn('flex shrink-0 gap-1 border-b border-border px-1', className)}
    >
      {children}
    </RadixTabs.List>
  );
}

export function Tab({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <RadixTabs.Trigger
      value={value}
      className={cn(
        'relative -mb-px rounded-t-md border-b-2 border-transparent px-2.5 py-1.5 text-sm text-muted-foreground',
        'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-foreground',
      )}
    >
      {children}
    </RadixTabs.Trigger>
  );
}

export function TabPanel({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <RadixTabs.Content
      value={value}
      className={cn(
        'min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {children}
    </RadixTabs.Content>
  );
}

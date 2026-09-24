import * as React from 'react';
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { cn } from '@oremedia/ui';

export const DropdownMenu = RadixMenu.Root;
export const DropdownMenuTrigger = RadixMenu.Trigger;

export function DropdownMenuContent({
  children,
  align = 'end',
}: {
  children: React.ReactNode;
  align?: 'start' | 'end';
}) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        align={align}
        sideOffset={4}
        className="z-50 min-w-44 rounded-md border border-border bg-background p-1 text-sm text-foreground shadow-md"
      >
        {children}
      </RadixMenu.Content>
    </RadixMenu.Portal>
  );
}

export interface DropdownMenuItemProps extends React.ComponentPropsWithoutRef<typeof RadixMenu.Item> {
  tone?: 'default' | 'danger';
}

export function DropdownMenuItem({ className, tone = 'default', ...props }: DropdownMenuItemProps) {
  return (
    <RadixMenu.Item
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 outline-none',
        'data-[highlighted]:bg-muted data-[disabled]:opacity-50',
        tone === 'danger' && 'text-status-critical',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator() {
  return <RadixMenu.Separator className="my-1 h-px bg-border" />;
}

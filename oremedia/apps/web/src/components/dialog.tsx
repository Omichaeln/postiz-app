import * as React from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { cn } from '@oremedia/ui';

/** Radix Dialog: focus is trapped and returned, Escape closes, the title is the accessible name (spec 21.3). */
export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof RadixDialog.Content> {
  title: string;
  description?: React.ReactNode;
  /** Set for alert-style dialogs that must be answered (unsaved changes, conflicts). */
  role?: 'dialog' | 'alertdialog';
}

export const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(function DialogContent(
  { title, description, role = 'dialog', className, children, ...props },
  ref,
) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-40 bg-foreground/40" />
      <RadixDialog.Content
        ref={ref}
        role={role}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex w-[min(92vw,32rem)] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 flex-col gap-3',
          'rounded-lg border border-border bg-background p-5 text-foreground shadow-lg outline-none',
          className,
        )}
        {...props}
      >
        <RadixDialog.Title className="text-base font-semibold">{title}</RadixDialog.Title>
        {description ? (
          <RadixDialog.Description className="text-sm text-muted-foreground">
            {description}
          </RadixDialog.Description>
        ) : (
          <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
        )}
        <div className="min-h-0 overflow-auto">{children}</div>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
});

export function DialogActions({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 flex flex-wrap justify-end gap-2">{children}</div>;
}

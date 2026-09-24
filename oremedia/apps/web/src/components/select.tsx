import * as React from 'react';
import * as RadixSelect from '@radix-ui/react-select';
import { cn } from '@oremedia/ui';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  className?: string;
  size?: 'sm' | 'md';
}

/** Radix Select styled through the tokens; keyboard navigation and typeahead come from Radix. */
export function Select({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
  size = 'md',
  ...aria
}: SelectProps) {
  return (
    <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <RadixSelect.Trigger
        id={id}
        {...aria}
        className={cn(
          'inline-flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-left text-sm text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          'disabled:cursor-not-allowed disabled:opacity-60 data-[placeholder]:text-muted-foreground',
          size === 'sm' ? 'h-8' : 'h-9',
          className,
        )}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon aria-hidden="true" className="text-muted-foreground">
          ▾
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-background text-foreground shadow-md"
        >
          <RadixSelect.Viewport className="p-1">
            {options.map((o) => (
              <RadixSelect.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className={cn(
                  'relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-6 pr-2 text-sm outline-none',
                  'data-[highlighted]:bg-muted data-[disabled]:opacity-50',
                )}
              >
                <RadixSelect.ItemIndicator className="absolute left-1.5" aria-hidden="true">
                  ✓
                </RadixSelect.ItemIndicator>
                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

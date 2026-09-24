import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

/**
 * Styled through the semantic tokens only (spec 8.4). Focus is always visible (spec 21.3); disabled buttons stay
 * in the tab order when they carry a reason so screen readers announce it (`aria-disabled` + `title`).
 */
export const buttonClasses = (variant: ButtonVariant = 'secondary', size: ButtonSize = 'md'): string =>
  cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'aria-disabled:cursor-not-allowed aria-disabled:opacity-60 disabled:cursor-not-allowed disabled:opacity-60',
    size === 'sm' ? 'h-8 px-2.5 text-sm' : 'h-9 px-3.5 text-sm',
    variant === 'primary' && 'border-primary bg-primary text-primary-foreground hover:opacity-90',
    variant === 'secondary' && 'border-border bg-secondary text-secondary-foreground hover:bg-muted',
    variant === 'ghost' && 'border-transparent bg-transparent text-foreground hover:bg-muted',
    variant === 'danger' && 'border-status-critical bg-transparent text-status-critical hover:bg-muted',
  );

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render the child element (e.g. a router Link) with the button styling. */
  asChild?: boolean;
  /** Disabled with a reason: announced and shown as a tooltip, and the button keeps keyboard focus. */
  disabledReason?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = 'secondary',
    size = 'md',
    asChild,
    disabledReason,
    disabled,
    onClick,
    type,
    ...props
  },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  const blocked = Boolean(disabledReason);
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(buttonClasses(variant, size), className)}
      aria-disabled={blocked || disabled || undefined}
      disabled={!blocked && disabled}
      title={disabledReason}
      onClick={blocked ? (e) => e.preventDefault() : onClick}
      {...props}
    />
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
  /** Required accessible name; the icon alone never carries meaning. */
  label: string;
  children: React.ReactNode;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className, size = 'md', children, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      aria-label={label}
      title={props.disabledReason ?? label}
      size={size}
      className={cn(size === 'sm' ? 'h-8 w-8 px-0' : 'h-9 w-9 px-0', className)}
      {...props}
    >
      <span aria-hidden="true" className="inline-flex">
        {children}
      </span>
    </Button>
  );
});

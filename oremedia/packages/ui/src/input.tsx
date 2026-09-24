import * as React from 'react';
import { cn } from './cn';

/**
 * The ring keys on `:focus-within`, not `:focus-visible`: text controls match both on every focus anyway, but a
 * date/time input has one more Tab stop (the picker button in its shadow tree) during which the input matches
 * neither `:focus` nor `:focus-visible`, only `:focus-within`; without this that stop shows no indicator (WCAG 2.4.7).
 */
const controlClasses =
  'w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground ' +
  'focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background ' +
  'disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-status-critical';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(controlClasses, 'h-9', className)} {...props} />;
});

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref,
) {
  return (
    <textarea ref={ref} className={cn(controlClasses, 'min-h-20 py-2 leading-5', className)} {...props} />
  );
});

export interface FieldProps {
  label: string;
  /** Id of the control; the label, hint and error are wired to it with `for`/`aria-describedby`. */
  htmlFor: string;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}

/** Label + control + hint/error, with the ARIA wiring every form field needs (spec 21.3). */
export function Field({ label, htmlFor, hint, error, className, children }: FieldProps) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <FieldDescribedBy ids={[hintId, errorId]} invalid={Boolean(error)}>
        {children}
      </FieldDescribedBy>
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-status-critical">
          <span aria-hidden="true">! </span>
          {error}
        </p>
      )}
    </div>
  );
}

function FieldDescribedBy({
  ids,
  invalid,
  children,
}: {
  ids: Array<string | undefined>;
  invalid: boolean;
  children: React.ReactNode;
}) {
  const describedBy = ids.filter(Boolean).join(' ') || undefined;
  if (!React.isValidElement<{ 'aria-describedby'?: string; 'aria-invalid'?: boolean }>(children))
    return children;
  return React.cloneElement(children, {
    'aria-describedby': describedBy,
    'aria-invalid': invalid || undefined,
  });
}

import { useId } from 'react';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <code className="text-muted-foreground">null</code>;
  if (typeof value === 'string') return <code className="break-all">"{value}"</code>;
  return <code>{String(value)}</code>;
}

function Node({ name, value, open }: { name: string; value: unknown; open: boolean }) {
  if (!isRecord(value))
    return (
      <li className="flex flex-wrap gap-x-1">
        <span className="text-muted-foreground">{name}:</span>
        <Primitive value={value} />
      </li>
    );
  const entries = Array.isArray(value)
    ? value.map((v, i): [string, unknown] => [String(i), v])
    : Object.entries(value);
  const shape = Array.isArray(value)
    ? `${entries.length} item${entries.length === 1 ? '' : 's'}`
    : `${entries.length} field${entries.length === 1 ? '' : 's'}`;
  return (
    <li>
      <details open={open}>
        <summary className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="text-muted-foreground">{name}</span>{' '}
          <span className="text-xs text-muted-foreground">({shape})</span>
        </summary>
        {entries.length > 0 && (
          <ul className="ml-3 flex flex-col gap-0.5 border-l border-border pl-2">
            {entries.map(([k, v]) => (
              <Node key={k} name={k} value={v} open={false} />
            ))}
          </ul>
        )}
      </details>
    </li>
  );
}

/**
 * A text-only JSON tree (native `<details>` so every level is keyboard-operable). It renders exactly the redacted
 * value the API returned; nothing is reconstructed from it.
 */
export function JsonTree({ value, label }: { value: unknown; label: string }) {
  const id = useId();
  return (
    <ul aria-labelledby={id} className="font-mono text-xs leading-5">
      <span id={id} className="sr-only">
        {label}
      </span>
      <Node name="input" value={value} open />
    </ul>
  );
}

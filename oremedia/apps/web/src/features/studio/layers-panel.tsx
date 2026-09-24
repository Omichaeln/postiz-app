import { useEffect, useRef, useState } from 'react';
import type { CreativePage } from '@oremedia/contracts/creative';
import { Badge, EmptyState, cn } from '@oremedia/ui';
import { elementTypeLabel, layerRows } from './document-helpers';

export interface LayersPanelProps {
  page: CreativePage;
  selection: string[];
  onSelect: (ids: string[]) => void;
  /** Enter on a row: select and move focus to the properties panel (spec 21.3 managed focus). */
  onActivate: (elementId: string) => void;
}

/**
 * Spec 21.3: the keyboard path to selection. A listbox with roving focus; every row is labelled for screen
 * readers. Options carry no interactive children (lock, order and removal live in the properties panel).
 */
export function LayersPanel({ page, selection, onSelect, onActivate }: LayersPanelProps) {
  const rows = layerRows(page);
  const selected = selection[0] ?? null;
  const [active, setActive] = useState<string | null>(selected ?? rows[0]?.element.id ?? null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (selected) setActive(selected);
  }, [selected]);
  useEffect(() => {
    if (active && !rows.some((r) => r.element.id === active)) setActive(rows[0]?.element.id ?? null);
  }, [rows, active]);

  const focusRow = (id: string) => {
    setActive(id);
    listRef.current?.querySelector<HTMLElement>(`[data-element-id="${id}"]`)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const i = rows.findIndex((r) => r.element.id === active);
    if (i < 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        focusRow(next.element.id);
        onSelect([next.element.id]);
      }
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const next = rows[e.key === 'Home' ? 0 : rows.length - 1];
      if (next) {
        focusRow(next.element.id);
        onSelect([next.element.id]);
      }
    } else if (e.key === ' ') {
      e.preventDefault();
      if (active) onSelect([active]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active) {
        onSelect([active]);
        onActivate(active);
      }
    }
  };

  if (rows.length === 0)
    return (
      <EmptyState
        title="No elements on this page"
        description="Insert an image from the assets tab or apply a template."
        className="m-3"
      />
    );

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label={`Layers of ${page.name}, front to back`}
      className="flex flex-col p-1"
      onKeyDown={onKeyDown}
      data-testid="layers"
    >
      {rows.map((row) => {
        const el = row.element;
        const isSelected = selection.includes(el.id);
        const status = [el.locked && 'locked', el.protected && 'protected', !el.visible && 'hidden']
          .filter(Boolean)
          .join(', ');
        return (
          <li
            key={el.id}
            id={`layer-${el.id}`}
            role="option"
            aria-selected={isSelected}
            aria-label={`${el.name}, ${elementTypeLabel[el.type]}${status ? `, ${status}` : ''}`}
            data-element-id={el.id}
            tabIndex={active === el.id ? 0 : -1}
            onClick={() => onSelect([el.id])}
            onFocus={() => setActive(el.id)}
            className={cn(
              'flex cursor-default items-center gap-1 rounded-md px-1.5 py-1 text-sm outline-none',
              isSelected ? 'bg-secondary text-secondary-foreground' : 'hover:bg-muted',
              'focus-visible:ring-2 focus-visible:ring-ring',
            )}
            style={{ paddingLeft: `${6 + row.depth * 14}px` }}
          >
            <span className="w-4 shrink-0 text-center text-xs text-muted-foreground" aria-hidden="true">
              {el.type === 'text'
                ? 'T'
                : el.type === 'image'
                  ? '▣'
                  : el.type === 'logo'
                    ? '◆'
                    : el.type === 'shape'
                      ? '◯'
                      : el.type === 'group'
                        ? '▸'
                        : '▦'}
            </span>
            <span className="min-w-0 flex-1 truncate">{el.name}</span>
            {el.protected && (
              <Badge tone="info" glyph={false}>
                Protected
              </Badge>
            )}
            {el.locked && (
              <Badge tone="neutral" glyph={false}>
                Locked
              </Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}

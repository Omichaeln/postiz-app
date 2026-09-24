import { useEffect, useRef, type KeyboardEvent } from 'react';
import { cn, toneGlyph } from '@oremedia/ui';
import {
  monthGrid,
  parseKey,
  publicationChip,
  weekDays,
  type CalendarView,
  type GridDay,
} from './publication-state';
import type { CalendarPublicationDto } from './use-publishing';

export interface CalendarGridProps {
  view: CalendarView;
  anchorKey: string;
  todayKey: string;
  selectedKey: string;
  onSelect: (key: string) => void;
  byDay: Map<string, CalendarPublicationDto[]>;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const longDate = (key: string) =>
  parseKey(key).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });

/**
 * Month and week views drawn from day keys in the brand's time zone. One roving tab stop (the selected day) and
 * arrow keys move it, so the whole grid is one keyboard stop and every day is reachable (spec 21.3). Each day names
 * its date and how many publications it holds; the state glyphs are decorative (the day list below carries them).
 */
export function CalendarGrid({ view, anchorKey, todayKey, selectedKey, onSelect, byDay }: CalendarGridProps) {
  const days = view === 'month' ? monthGrid(anchorKey) : weekDays(anchorKey);
  const listRef = useRef<HTMLOListElement>(null);
  const hasSelected = days.some((d) => d.key === selectedKey);
  const focusKey = hasSelected ? selectedKey : (days.find((d) => d.inMonth)?.key ?? days[0]?.key);
  const pendingFocus = useRef<string | null>(null);

  useEffect(() => {
    if (!pendingFocus.current) return;
    const el = listRef.current?.querySelector<HTMLButtonElement>(
      `button[data-day="${pendingFocus.current}"]`,
    );
    pendingFocus.current = null;
    el?.focus();
  });

  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const step = delta[e.key];
    let target: GridDay | undefined;
    if (step !== undefined) target = days[index + step];
    else if (e.key === 'Home') target = days[index - (index % 7)];
    else if (e.key === 'End') target = days[index - (index % 7) + 6];
    if (!target) return;
    e.preventDefault();
    pendingFocus.current = target.key;
    onSelect(target.key);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground" aria-hidden="true">
        {WEEKDAYS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <ol
        ref={listRef}
        aria-label={view === 'month' ? 'Days of the month' : 'Days of the week'}
        className="grid grid-cols-7 gap-1"
      >
        {days.map((day, index) => {
          const items = byDay.get(day.key) ?? [];
          const selected = day.key === selectedKey;
          const isToday = day.key === todayKey;
          return (
            <li key={day.key} className="min-w-0">
              <button
                type="button"
                data-day={day.key}
                data-testid={`day-${day.key}`}
                tabIndex={day.key === focusKey ? 0 : -1}
                aria-pressed={selected}
                aria-current={isToday ? 'date' : undefined}
                aria-label={`${longDate(day.key)}${isToday ? ', today' : ''}: ${items.length} publication${items.length === 1 ? '' : 's'}`}
                onClick={() => onSelect(day.key)}
                onKeyDown={(e) => move(e, index)}
                className={cn(
                  'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md border p-1 text-left text-xs',
                  view === 'month' ? 'min-h-14 sm:min-h-20' : 'min-h-20 sm:min-h-28',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'border-accent bg-secondary' : 'border-border hover:bg-muted',
                  !day.inMonth && 'text-muted-foreground opacity-70',
                )}
              >
                <span className={cn('font-medium', isToday && 'underline underline-offset-2')}>
                  {day.dayOfMonth}
                </span>
                {items.length > 0 && (
                  <span className="flex flex-wrap items-center gap-0.5" aria-hidden="true">
                    {items.slice(0, view === 'month' ? 3 : 6).map((p) => {
                      const chip = publicationChip(p.state);
                      return (
                        <span
                          key={p.publicationId}
                          className={cn(
                            'inline-flex h-4 min-w-4 items-center justify-center rounded-sm border px-0.5 text-[10px] leading-none',
                          )}
                          title={chip.label}
                        >
                          {toneGlyph[chip.tone]}
                        </span>
                      );
                    })}
                    <span className="text-[10px]">{items.length}</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

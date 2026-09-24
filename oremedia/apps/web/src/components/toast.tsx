import * as React from 'react';
import { Button, StatusBanner, cn, type Tone } from '@oremedia/ui';

export interface ToastInput {
  tone: Tone;
  title: string;
  description?: React.ReactNode;
  /** Milliseconds before the toast goes away; critical toasts stay until dismissed. */
  ttlMs?: number;
}

interface Toast extends ToastInput {
  id: number;
}

interface ToastApi {
  toast: (input: ToastInput) => void;
}

type Placement = 'bottom' | 'top';

interface Timer {
  remaining: number;
  startedAt: number;
  handle: number | undefined;
}

const ToastContext = React.createContext<ToastApi | null>(null);

/** Distance of the stack from the viewport edge: `bottom-4` / `top-4` / `right-4` (1rem). */
const EDGE_PX = 16;

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const overlapArea = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/**
 * WCAG 2.2 SC 2.4.11 Focus Not Obscured: the stack sits at the bottom unless it would overlap the focused control,
 * then it moves to the top edge (whichever edge covers less of the control). The stack is capped at 40vh, so the two
 * placements never overlap each other and a control hidden by one is always clear of the other.
 */
function placementFor(stack: HTMLElement, focused: Element | null): Placement {
  if (!focused || focused === document.body || stack.contains(focused)) return 'bottom';
  const f = focused.getBoundingClientRect();
  const height = stack.offsetHeight;
  if (height === 0 || f.width === 0 || f.height === 0) return 'bottom';
  const right = window.innerWidth - EDGE_PX;
  const left = right - stack.offsetWidth;
  const bottom: Box = {
    top: window.innerHeight - EDGE_PX - height,
    bottom: window.innerHeight - EDGE_PX,
    left,
    right,
  };
  const top: Box = { top: EDGE_PX, bottom: EDGE_PX + height, left, right };
  const coveredAtBottom = overlapArea(f, bottom);
  return coveredAtBottom > 0 && overlapArea(f, top) < coveredAtBottom ? 'top' : 'bottom';
}

/**
 * Transient notices rendered as StatusBanners (glyph + text; never colour alone). The stack is a persistent polite
 * live region (critical toasts are role=alert), so additions are announced; it never covers the focused control
 * (2.4.11); timers pause while the pointer or focus is on a toast (2.2.1); Escape or the Dismiss button closes a toast
 * from the keyboard and focus returns to where it was before it entered the stack.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const [placement, setPlacement] = React.useState<Placement>('bottom');
  const counter = React.useRef(0);
  const stackRef = React.useRef<HTMLElement>(null);
  const timers = React.useRef(new Map<number, Timer>());
  const pause = React.useRef({ hover: false, focus: false });
  const lastFocusOutside = React.useRef<HTMLElement | null>(null);

  const dismiss = React.useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer?.handle !== undefined) window.clearTimeout(timer.handle);
    timers.current.delete(id);
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const startTimer = React.useCallback(
    (id: number) => {
      const timer = timers.current.get(id);
      if (!timer || timer.handle !== undefined || pause.current.hover || pause.current.focus) return;
      timer.startedAt = Date.now();
      timer.handle = window.setTimeout(() => dismiss(id), timer.remaining);
    },
    [dismiss],
  );

  const syncTimers = React.useCallback(() => {
    const paused = pause.current.hover || pause.current.focus;
    for (const [id, timer] of timers.current) {
      if (paused && timer.handle !== undefined) {
        window.clearTimeout(timer.handle);
        timer.handle = undefined;
        timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
      } else if (!paused) startTimer(id);
    }
  }, [startTimer]);

  const toast = React.useCallback(
    (input: ToastInput) => {
      const id = ++counter.current;
      setToasts((ts) => [...ts, { ...input, id }]);
      const ttl = input.ttlMs ?? (input.tone === 'critical' ? 0 : 6000);
      if (ttl > 0) {
        timers.current.set(id, { remaining: ttl, startedAt: Date.now(), handle: undefined });
        startTimer(id);
      }
    },
    [startTimer],
  );

  const place = React.useCallback(() => {
    const stack = stackRef.current;
    if (stack) setPlacement(placementFor(stack, document.activeElement));
  }, []);

  // Re-place when focus moves, the page scrolls or resizes, and whenever the stack changes size. A dismissed toast
  // takes its pointer and focus with it (no leave/blur event), so the pause state is re-read from the DOM too.
  React.useLayoutEffect(() => {
    place();
    const stack = stackRef.current;
    if (!stack) return;
    pause.current = {
      hover: stack.querySelector(':hover') !== null,
      focus: stack.contains(document.activeElement),
    };
    syncTimers();
  }, [place, syncTimers, toasts]);
  React.useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement && !stackRef.current?.contains(e.target))
        lastFocusOutside.current = e.target;
      place();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', schedule);
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', schedule);
      document.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
    };
  }, [place]);

  React.useEffect(
    () => () => {
      for (const timer of timers.current.values())
        if (timer.handle !== undefined) window.clearTimeout(timer.handle);
    },
    [],
  );

  /** Keyboard dismissal: close the toast, then return focus to the control the person was on. */
  const dismissFromKeyboard = (id: number) => {
    dismiss(id);
    const back = lastFocusOutside.current;
    if (back?.isConnected) back.focus({ preventScroll: true });
  };

  const api = React.useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <section
        ref={stackRef}
        aria-label="Notifications"
        aria-live="polite"
        aria-relevant="additions"
        data-testid="toast-stack"
        data-placement={placement}
        onFocus={() => {
          pause.current.focus = true;
          syncTimers();
        }}
        onBlur={(e) => {
          if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
          pause.current.focus = false;
          syncTimers();
        }}
        className={cn(
          'pointer-events-none fixed right-4 z-50 flex max-h-[40vh] w-[min(92vw,26rem)] flex-col gap-2 overflow-y-auto',
          placement === 'top' ? 'top-4' : 'bottom-4',
        )}
      >
        {toasts.map((t) => (
          <StatusBanner
            key={t.id}
            tone={t.tone}
            title={t.title}
            description={t.description}
            // Polite toasts are announced by the stack's live region; critical ones interrupt (role=alert).
            role={t.tone === 'critical' ? 'alert' : 'group'}
            aria-label={t.tone === 'critical' ? undefined : t.title}
            data-toast-id={t.id}
            className="pointer-events-auto shrink-0 bg-background shadow-md"
            onPointerEnter={() => {
              pause.current.hover = true;
              syncTimers();
            }}
            onPointerLeave={() => {
              pause.current.hover = false;
              syncTimers();
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.stopPropagation();
              dismissFromKeyboard(t.id);
            }}
            actions={
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => (e.detail === 0 ? dismissFromKeyboard(t.id) : dismiss(t.id))}
                aria-label={`Dismiss: ${t.title}`}
              >
                Dismiss
              </Button>
            }
          />
        ))}
      </section>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = React.useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside ToastProvider');
  return api;
}

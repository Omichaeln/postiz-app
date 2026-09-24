import * as React from 'react';
import { Button, StatusBanner, type Tone } from '@oremedia/ui';

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

const ToastContext = React.createContext<ToastApi | null>(null);

/** Transient notices rendered as StatusBanners (glyph + text + live region; never colour alone). */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const counter = React.useRef(0);
  const dismiss = React.useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const toast = React.useCallback(
    (input: ToastInput) => {
      const id = ++counter.current;
      setToasts((ts) => [...ts, { ...input, id }]);
      const ttl = input.ttlMs ?? (input.tone === 'critical' ? 0 : 6000);
      if (ttl > 0) window.setTimeout(() => dismiss(id), ttl);
    },
    [dismiss],
  );
  const api = React.useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,26rem)] flex-col gap-2">
        {toasts.map((t) => (
          <StatusBanner
            key={t.id}
            tone={t.tone}
            title={t.title}
            description={t.description}
            className="pointer-events-auto bg-background shadow-md"
            actions={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => dismiss(t.id)}
                aria-label={`Dismiss: ${t.title}`}
              >
                Dismiss
              </Button>
            }
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = React.useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside ToastProvider');
  return api;
}

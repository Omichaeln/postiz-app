import { Outlet, Link } from 'react-router';
import { Button } from '@oremedia/ui';
import { TooltipProvider } from '../components/tooltip';
import { ToastProvider } from '../components/toast';
import { useTheme } from '../lib/theme';
import { clearBearerToken, getBearerToken } from '../lib/session';

export interface RootContext {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}

/** Application chrome shared by every route: skip link, theme, providers. Routes render their own headers. */
export function RootLayout() {
  const { theme, toggle } = useTheme();
  return (
    <TooltipProvider>
      <ToastProvider>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <div className="flex h-full min-h-0 flex-col">
          <Outlet context={{ theme, toggleTheme: toggle } satisfies RootContext} />
        </div>
      </ToastProvider>
    </TooltipProvider>
  );
}

/** The slim top bar used by the portfolio-level screens (brand screens render their own header, spec 11.1). */
export function TopBar({ title, children }: { title: string; children?: React.ReactNode }) {
  const { theme, toggle } = useTheme();
  const signedInWithToken = Boolean(getBearerToken());
  return (
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2">
      <div className="flex items-center gap-3">
        <Link to="/portfolio" className="text-sm font-semibold">
          Oremedia
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <span className="text-sm">{title}</span>
      </div>
      <div className="flex items-center gap-2">
        {children}
        <Button size="sm" variant="ghost" onClick={toggle} aria-pressed={theme === 'dark'}>
          {theme === 'dark' ? 'Light theme' : 'Dark theme'}
        </Button>
        {signedInWithToken && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              clearBearerToken();
              window.location.assign('/sign-in');
            }}
          >
            Sign out
          </Button>
        )}
      </div>
    </header>
  );
}

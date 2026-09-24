import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button, Field, Input, Panel, StatusBanner } from '@oremedia/ui';
import { TopBar } from '../root';
import { useTRPCClient } from '../../lib/trpc';
import { toUiError } from '../../lib/errors';
import { clearBearerToken, hasCredential, setBearerToken } from '../../lib/session';

/**
 * D-03 (authentication provider) is an open human decision: the API has no credentials procedure yet. What exists
 * is bearer authentication of session tokens (`ses_…`) and API keys (`ak_…`) plus cookie sessions
 * (apps/api/src/context.ts). This screen says so and accepts a token; it invents no flow.
 */
export function SignInRoute() {
  const client = useTRPCClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/portfolio';
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const verifyAndContinue = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.access.listCompanies.query();
      navigate(next.startsWith('/') ? next : '/portfolio', { replace: true });
    } catch (err) {
      const ui = toUiError(err);
      clearBearerToken();
      setError(
        ui.kind === 'sign_in'
          ? 'That token is not a valid, unexpired session token.'
          : ui.kind === 'forbidden'
            ? `${ui.message} Only a user session (ses_…) has a portfolio.`
            : ui.message,
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setError('Paste a session token first.');
      return;
    }
    setBearerToken(token);
    void verifyAndContinue();
  };

  return (
    <>
      <TopBar title="Sign in" />
      <main id="main" className="mx-auto w-full max-w-lg p-6">
        <Panel title="Sign in to Oremedia" className="mb-4">
          <p className="mb-3 text-sm text-muted-foreground">
            The authentication provider (decision D-03) has not been chosen yet, so there is no email and
            password sign-in. The API accepts a session token issued for your user; paste it below. It is kept
            only in this browser tab.
          </p>
          <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
            <Field label="Session token" htmlFor="token" hint="Starts with ses_" error={error ?? undefined}>
              <Input
                id="token"
                name="token"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ses_…"
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? 'Checking…' : 'Continue'}
              </Button>
              {hasCredential() && !token && (
                <Button type="button" onClick={() => void verifyAndContinue()} disabled={busy}>
                  Continue with the existing session
                </Button>
              )}
            </div>
          </form>
        </Panel>
        <StatusBanner
          tone="info"
          title="Cookie sessions"
          description="When a session cookie is set by the platform, requests carry it automatically together with the CSRF header; no token is needed here."
        />
      </main>
    </>
  );
}

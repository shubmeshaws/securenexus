'use client';

import { useState } from 'react';
import { Loader2 } from '@/lib/icons';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SNYK_TOKEN_SETTINGS_URL } from '@/lib/security/snyk-constants';

type SnykAuthResponse = {
  authenticated: boolean;
  username?: string | null;
  authUrl?: string | null;
  phase?: string | null;
  error?: string | null;
  running?: boolean;
  tokenSettingsUrl?: string;
};

export function SnykAuthPanel({
  authenticated,
  username,
  onRefreshTools,
}: {
  authenticated?: boolean | null;
  username?: string | null;
  onRefreshTools: () => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function checkAuthStatus(): Promise<SnykAuthResponse> {
    const result = await apiFetch<SnykAuthResponse>('/api/security/tools/snyk-auth');
    onRefreshTools();
    return result;
  }

  async function handleCheckStatus() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await checkAuthStatus();
      if (result.authenticated) {
        setMessage(`Authenticated as ${result.username ?? 'Snyk user'}.`);
      } else {
        setMessage(result.phase ?? 'Not authenticated yet. Complete Snyk login or save an API token.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check Snyk auth status.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveToken() {
    if (!token.trim()) {
      setError('Paste your Snyk API token first.');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apiFetch<SnykAuthResponse>('/api/security/tools/snyk-auth', {
        method: 'POST',
        body: JSON.stringify({ action: 'token', token: token.trim() }),
      });
      if (result.authenticated) {
        setToken('');
        setMessage(`Authenticated as ${result.username ?? 'Snyk user'}.`);
        onRefreshTools();
      } else {
        setError(result.error ?? 'Snyk rejected the token.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Snyk token.');
    } finally {
      setBusy(false);
    }
  }

  async function handleBrowserAuth() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      let job = await apiFetch<SnykAuthResponse>('/api/security/tools/snyk-auth', {
        method: 'POST',
        body: JSON.stringify({ action: 'start' }),
      });

      const startedAt = Date.now();
      while (job.running && Date.now() - startedAt < 30_000) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        job = await apiFetch<SnykAuthResponse>('/api/security/tools/snyk-auth');
      }

      if (job.authUrl) {
        window.open(job.authUrl, '_blank', 'noopener,noreferrer');
        setMessage(
          'Snyk login opened in a new tab. Sign in, then click Check auth status. If login fails, use an API token instead.'
        );
        return;
      }

      if (job.authenticated) {
        setMessage(`Authenticated as ${job.username ?? 'Snyk user'}.`);
        onRefreshTools();
        return;
      }

      setError(job.error ?? 'Could not start Snyk browser authentication.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start Snyk authentication.');
    } finally {
      setBusy(false);
    }
  }

  if (authenticated) {
    return (
      <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2 text-[10px] leading-relaxed text-emerald-800 dark:text-emerald-200">
        Snyk is authenticated{username ? ` as ${username}` : ''}. Enable this tool and run live scans
        with <code className="font-mono">snyk code test</code>.
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2.5 text-[10px] leading-relaxed text-amber-950 dark:text-amber-100">
      <p>
        <strong className="font-medium">Authentication required.</strong> SecureNexus uses the Snyk
        CLI on the server. Paste a Snyk API token below (recommended for servers), or use{' '}
        <code className="font-mono">Authenticate in browser</code> when SecureNexus runs on the same
        machine as your browser.
      </p>

      <div className="space-y-1.5">
        <label className="text-[10px] font-medium text-foreground" htmlFor="snyk-api-token">
          Snyk API token
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="snyk-api-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Paste token from Snyk account settings"
            className="h-8 text-[11px]"
            disabled={busy}
          />
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0 text-[10px]"
            disabled={busy || !token.trim()}
            onClick={() => void handleSaveToken()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save token'}
          </Button>
        </div>
        <a
          href={SNYK_TOKEN_SETTINGS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-[10px] text-blue-600 hover:underline dark:text-blue-400"
        >
          Get API token from Snyk account
        </a>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-[10px]"
          disabled={busy}
          onClick={() => void handleBrowserAuth()}
        >
          Authenticate in browser
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 text-[10px]"
          disabled={busy}
          onClick={() => void handleCheckStatus()}
        >
          {busy ? (
            <>
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              Checking…
            </>
          ) : (
            'Check auth status'
          )}
        </Button>
      </div>

      {message ? <p className="text-[10px] text-emerald-700 dark:text-emerald-300">{message}</p> : null}
      {error ? <p className="text-[10px] text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}

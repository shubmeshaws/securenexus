'use client';

import { useState } from 'react';
import { Loader2 } from '@/lib/icons';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DEFAULT_SONAR_HOST_URL, SONAR_TOKEN_DOCS_URL } from '@/lib/security/sonarqube-constants';

type SonarqubeAuthResponse = {
  authenticated: boolean;
  username?: string | null;
  serverUrl?: string | null;
  phase?: string | null;
  error?: string | null;
  tokenDocsUrl?: string;
};

export function SonarqubeAuthPanel({
  authenticated,
  username,
  serverUrl,
  onRefreshTools,
}: {
  authenticated?: boolean | null;
  username?: string | null;
  serverUrl?: string | null;
  onRefreshTools: () => void;
}) {
  const [hostUrl, setHostUrl] = useState(serverUrl ?? DEFAULT_SONAR_HOST_URL);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCheckStatus() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apiFetch<SonarqubeAuthResponse>('/api/security/tools/sonarqube-auth');
      onRefreshTools();
      if (result.authenticated) {
        setMessage(
          `Authenticated as ${result.username ?? 'SonarQube user'}${result.serverUrl ? ` on ${result.serverUrl}` : ''}.`
        );
        if (result.serverUrl) setHostUrl(result.serverUrl);
      } else {
        setMessage(result.phase ?? 'Not authenticated. Save your SonarQube server URL and user token.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check SonarQube auth status.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveToken() {
    if (!hostUrl.trim()) {
      setError('Enter your SonarQube server URL.');
      return;
    }
    if (!token.trim()) {
      setError('Paste your SonarQube user token first.');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apiFetch<SonarqubeAuthResponse>('/api/security/tools/sonarqube-auth', {
        method: 'POST',
        body: JSON.stringify({
          action: 'token',
          serverUrl: hostUrl.trim(),
          token: token.trim(),
        }),
      });
      if (result.authenticated) {
        setToken('');
        setMessage(`Authenticated as ${result.username ?? 'SonarQube user'}.`);
        onRefreshTools();
      } else {
        setError(result.error ?? 'SonarQube rejected the token.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save SonarQube token.');
    } finally {
      setBusy(false);
    }
  }

  if (authenticated) {
    return (
      <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2 text-[10px] leading-relaxed text-emerald-800 dark:text-emerald-200">
        SonarQube is authenticated{username ? ` as ${username}` : ''}
        {serverUrl ? ` on ${serverUrl}` : ''}. Enable this tool and run live SAST scans with
        sonar-scanner.
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2.5 text-[10px] leading-relaxed text-amber-950 dark:text-amber-100">
      <p>
        <strong className="font-medium">Authentication required.</strong> SecureNexus runs
        sonar-scanner on the server and uploads results to your SonarQube instance. Paste the server
        URL and a user token from your SonarQube account.
      </p>

      <div className="space-y-1.5">
        <label className="text-[10px] font-medium text-foreground" htmlFor="sonarqube-server-url">
          SonarQube server URL
        </label>
        <Input
          id="sonarqube-server-url"
          type="url"
          value={hostUrl}
          onChange={(event) => setHostUrl(event.target.value)}
          placeholder="http://localhost:9000"
          className="h-8 text-[11px]"
          disabled={busy}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] font-medium text-foreground" htmlFor="sonarqube-api-token">
          User token
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="sonarqube-api-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Paste token from SonarQube → My Account → Security"
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
          href={SONAR_TOKEN_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-[10px] text-blue-600 hover:underline dark:text-blue-400"
        >
          How to generate a SonarQube user token
        </a>
      </div>

      <div className="flex flex-wrap gap-2">
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

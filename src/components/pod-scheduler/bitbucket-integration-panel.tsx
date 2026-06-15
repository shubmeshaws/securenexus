'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck,
  Bolt,
  ChevronRight,
  CircleX,
  FileUp,
  Loader2,
  PenLine,
  PlusCircle,
  RefreshCcw,
  Trash2,
} from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch } from '@/lib/api-client';
import { TECH_ICONS } from '@/lib/tech-icons';
import { PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const SECRET_PLACEHOLDER = '••••••••';

interface BitbucketConnection {
  username: string;
  workspace: string | null;
  tokenType: 'user_api' | 'workspace_access';
  tokenSet: boolean;
  status: 'connected' | 'disconnected' | 'error';
  lastTestAt: string | null;
  lastError: string | null;
  connected: boolean;
}

interface GitRepository {
  id: string;
  name: string;
  workspace: string;
  repoSlug: string;
  repoUrl: string;
  defaultBranch: string | null;
  pullIntervalMin: number;
  enabled: boolean;
  isCloned: boolean;
  clonedAt: string | null;
  syncStatus: 'idle' | 'cloning' | 'pulling';
  syncStartedAt: string | null;
  clonePath: string | null;
  lastPullAt: string | null;
  lastCommitSha: string | null;
  lastPullStatus: string | null;
  lastPullError: string | null;
  appSourceCount: number;
}

interface ArgoCDAppSource {
  id: string;
  argocdApp: string;
  argocdInstanceName: string;
  cluster: string | null;
  namespace: string | null;
  repoUrl: string;
  repoPath: string | null;
  targetRevision: string | null;
  helmValueFiles: string[];
  gitRepositoryName: string | null;
}

interface BitbucketTestResult {
  ok: boolean;
  message: string;
}

type IntervalUnit = 'minutes' | 'hours' | 'days';

function intervalToMinutes(value: number, unit: IntervalUnit): number {
  if (unit === 'hours') return value * 60;
  if (unit === 'days') return value * 1440;
  return value;
}

function displayInUnit(minutes: number, unit: IntervalUnit): number {
  if (unit === 'days') return Math.max(1, Math.round(minutes / 1440));
  if (unit === 'hours') return Math.max(1, Math.round(minutes / 60));
  return Math.max(1, minutes);
}

function formatPullInterval(minutes: number): string {
  const { value, unit } = minutesToDisplay(minutes);
  const label = unit === 'minutes' ? 'min' : unit === 'hours' ? 'hr' : 'day';
  const plural = value === 1 ? label : `${label}s`;
  return `${value} ${plural}`;
}

function minutesToDisplay(minutes: number): { value: number; unit: IntervalUnit } {
  if (minutes >= 1440 && minutes % 1440 === 0) {
    return { value: minutes / 1440, unit: 'days' };
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    return { value: minutes / 60, unit: 'hours' };
  }
  return { value: minutes, unit: 'minutes' };
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function BitbucketIntegrationPanel() {
  const queryClient = useQueryClient();

  const { data: connectionData, isLoading: connectionLoading } = useQuery({
    queryKey: ['bitbucket-connection'],
    queryFn: () => apiFetch<{ connection: BitbucketConnection | null }>('/api/admin/bitbucket/connection'),
  });

  const { data: reposData, isLoading: reposLoading } = useQuery({
    queryKey: ['bitbucket-repositories'],
    queryFn: () => apiFetch<{ repositories: GitRepository[] }>('/api/admin/bitbucket/repositories'),
    enabled: Boolean(connectionData?.connection?.connected),
    refetchInterval: (query) => {
      const repos = query.state.data?.repositories ?? [];
      const syncing = repos.some(
        (r) => r.syncStatus === 'cloning' || r.syncStatus === 'pulling'
      );
      return syncing ? 3000 : false;
    },
  });

  const { data: sourcesData, isLoading: sourcesLoading } = useQuery({
    queryKey: ['bitbucket-app-sources'],
    queryFn: () => apiFetch<{ appSources: ArgoCDAppSource[] }>('/api/admin/bitbucket/app-sources'),
    enabled: Boolean(connectionData?.connection?.connected),
  });

  const connection = connectionData?.connection;
  const repositories = reposData?.repositories ?? [];
  const appSources = sourcesData?.appSources ?? [];

  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [tokenType, setTokenType] = useState<'user_api' | 'workspace_access'>('user_api');
  const [testResult, setTestResult] = useState<BitbucketTestResult | null>(null);
  const [appSourcesExpanded, setAppSourcesExpanded] = useState(false);

  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [editingRepo, setEditingRepo] = useState<GitRepository | null>(null);
  const [repoForm, setRepoForm] = useState({
    workspace: '',
    repoUrl: '',
    defaultBranch: '',
    intervalValue: 1,
    intervalUnit: 'days' as IntervalUnit,
    enabled: true,
  });
  const [syncActionMessage, setSyncActionMessage] = useState<string | null>(null);
  const [deleteRepo, setDeleteRepo] = useState<GitRepository | null>(null);
  const [repoSaveError, setRepoSaveError] = useState<string | null>(null);
  const [activeRepoAction, setActiveRepoAction] = useState<{
    id: string;
    action: 'clone' | 'pull';
  } | null>(null);

  useEffect(() => {
    if (!connection) return;
    setUsername(connection.username ?? '');
    setWorkspace(connection.workspace ?? '');
    setTokenType(connection.tokenType ?? 'user_api');
    setToken(connection.tokenSet ? SECRET_PLACEHOLDER : '');
  }, [connection]);

  const saveConnectionMutation = useMutation({
    mutationFn: () =>
      apiFetch('/api/admin/bitbucket/connection', {
        method: 'PUT',
        body: JSON.stringify({
          username,
          token: token && token !== SECRET_PLACEHOLDER ? token : undefined,
          workspace: workspace || null,
          tokenType,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bitbucket-connection'] });
    },
  });

  const testMutation = useMutation({
    mutationFn: () =>
      apiFetch<BitbucketTestResult>('/api/admin/bitbucket/connection/test', {
        method: 'POST',
        body: JSON.stringify({
          username,
          token: token && token !== SECRET_PLACEHOLDER ? token : undefined,
          workspace: workspace || null,
          tokenType,
        }),
      }),
    onMutate: () => setTestResult(null),
    onSuccess: (result) => {
      setTestResult(result);
      if (result.ok) {
        queryClient.invalidateQueries({ queryKey: ['bitbucket-connection'] });
        queryClient.invalidateQueries({ queryKey: ['bitbucket-repositories'] });
      }
    },
    onError: (err: unknown) =>
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Connection test failed',
      }),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => apiFetch('/api/admin/bitbucket/connection', { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bitbucket-connection'] });
      queryClient.invalidateQueries({ queryKey: ['bitbucket-repositories'] });
      queryClient.invalidateQueries({ queryKey: ['bitbucket-app-sources'] });
      setToken('');
    },
  });

  const openAddRepo = () => {
    setEditingRepo(null);
    setRepoForm({
      workspace: workspace || connection?.workspace || '',
      repoUrl: '',
      defaultBranch: '',
      intervalValue: 1,
      intervalUnit: 'days',
      enabled: true,
    });
    setRepoDialogOpen(true);
    setRepoSaveError(null);
  };

  const openEditRepo = (repo: GitRepository) => {
    const display = minutesToDisplay(repo.pullIntervalMin);
    setEditingRepo(repo);
    setRepoForm({
      workspace: repo.workspace,
      repoUrl: repo.repoUrl,
      defaultBranch: repo.defaultBranch ?? '',
      intervalValue: display.value,
      intervalUnit: display.unit,
      enabled: repo.enabled,
    });
    setRepoDialogOpen(true);
    setRepoSaveError(null);
  };

  const saveRepoMutation = useMutation({
    mutationFn: async () => {
      const pullIntervalMin = intervalToMinutes(repoForm.intervalValue, repoForm.intervalUnit);
      if (editingRepo) {
        return apiFetch<{ repository: GitRepository }>(
          `/api/admin/bitbucket/repositories/${editingRepo.id}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              defaultBranch: repoForm.defaultBranch.trim() || null,
              pullIntervalMin,
              enabled: repoForm.enabled,
            }),
          }
        );
      }
      return apiFetch<{ repository: GitRepository }>('/api/admin/bitbucket/repositories', {
        method: 'POST',
        body: JSON.stringify({
          workspace: repoForm.workspace,
          repoUrl: repoForm.repoUrl,
          defaultBranch: repoForm.defaultBranch.trim() || null,
          pullIntervalMin,
          enabled: repoForm.enabled,
        }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['bitbucket-repositories'] });
      queryClient.invalidateQueries({ queryKey: ['bitbucket-app-sources'] });
      setRepoSaveError(null);
      setRepoDialogOpen(false);
      setEditingRepo(null);
    },
    onError: (err: unknown) => {
      setRepoSaveError(err instanceof Error ? err.message : 'Failed to save repository');
    },
  });

  const deleteRepoMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: boolean; message: string }>(
        `/api/admin/bitbucket/repositories/${id}`,
        { method: 'DELETE' }
      ),
    onSuccess: (result) => {
      setSyncActionMessage(result.message ?? 'Repository deleted');
      queryClient.invalidateQueries({ queryKey: ['bitbucket-repositories'] });
      setDeleteRepo(null);
    },
    onError: (err: unknown) => {
      setSyncActionMessage(err instanceof Error ? err.message : 'Failed to delete repository');
    },
  });

  const cloneRepoMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: boolean; message: string; repoId: string }>(
        `/api/admin/bitbucket/repositories/${id}/clone`,
        { method: 'POST' }
      ),
    onMutate: (id) => setActiveRepoAction({ id, action: 'clone' }),
    onSettled: () => setActiveRepoAction(null),
    onSuccess: (result) => {
      setSyncActionMessage(result.message);
      if (result.ok) {
        queryClient.invalidateQueries({ queryKey: ['bitbucket-repositories'] });
        queryClient.invalidateQueries({ queryKey: ['resource-audit'] });
      }
    },
    onError: (err: unknown) => {
      setSyncActionMessage(err instanceof Error ? err.message : 'Clone failed');
    },
  });

  const pullRepoMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: boolean; message: string; repoId: string }>(
        `/api/admin/bitbucket/repositories/${id}/pull`,
        { method: 'POST' }
      ),
    onMutate: (id) => setActiveRepoAction({ id, action: 'pull' }),
    onSettled: () => setActiveRepoAction(null),
    onSuccess: (result) => {
      setSyncActionMessage(result.message);
      if (result.ok) {
        queryClient.invalidateQueries({ queryKey: ['bitbucket-repositories'] });
        queryClient.invalidateQueries({ queryKey: ['resource-audit'] });
      }
    },
    onError: (err: unknown) => {
      setSyncActionMessage(err instanceof Error ? err.message : 'Pull failed');
    },
  });

  const isRepoSyncing = (repo: GitRepository) =>
    activeRepoAction?.id === repo.id ||
    repo.syncStatus === 'cloning' ||
    repo.syncStatus === 'pulling';

  const syncSourcesMutation = useMutation({
    mutationFn: () => apiFetch('/api/admin/bitbucket/app-sources/sync', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bitbucket-app-sources'] });
      queryClient.invalidateQueries({ queryKey: ['bitbucket-repositories'] });
    },
  });

  if (connectionLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-blue-500/50" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <PanelHeader
          title="Bitbucket Integration"
          brandIconSrc={TECH_ICONS.bitbucket}
          brandIconAlt="Bitbucket"
          accent="sky"
        />
        <p className="mt-2 text-[11px] text-muted-foreground">
          Connect Bitbucket to clone repositories and track git-based resource changes. ArgoCD
          application sources (repo URL, path, branch, Helm value files) are joined with git diffs
          for accurate CPU, memory, and replica change history.
        </p>
      </div>

      <div className="space-y-4 rounded-xl border border-border bg-secondary/10 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Connection</p>
            {connection?.connected ? (
              <Badge variant="success">Connected</Badge>
            ) : connection?.status === 'error' ? (
              <Badge variant="failed">Error</Badge>
            ) : (
              <Badge variant="unknown">Not connected</Badge>
            )}
          </div>
          {connection?.connected && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
            >
              Disconnect
            </Button>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label>Token type</Label>
            <Select
              value={tokenType}
              onValueChange={(v) => {
                setTokenType(v as 'user_api' | 'workspace_access');
                setTestResult(null);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user_api">User API token (Atlassian account)</SelectItem>
                <SelectItem value="workspace_access">Workspace access token</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {tokenType === 'user_api'
                ? 'Create at id.atlassian.com → Security → API tokens. Required scopes: read:user:bitbucket, read:repository:bitbucket.'
                : 'Create in Bitbucket → Workspace settings → Access tokens. Uses Bearer auth (not your login email).'}
            </p>
          </div>

          {tokenType === 'user_api' && (
            <div className="space-y-2 sm:col-span-2">
              <Label>Atlassian account email</Label>
              <Input
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setTestResult(null);
                }}
                placeholder="you@company.com"
              />
              <p className="text-[11px] text-muted-foreground">
                Not your Bitbucket username. Find it under Bitbucket → Personal settings → Email aliases.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label>Workspace slug {tokenType === 'workspace_access' ? '(required)' : '(optional)'}</Label>
            <Input
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="my-workspace"
            />
            <p className="text-[11px] text-muted-foreground">
              From bitbucket.org/<strong>my-workspace</strong>/…
            </p>
          </div>
          <div className="space-y-2">
            <Label>API / access token</Label>
            <Input
              type="password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setTestResult(null);
              }}
              placeholder={connection?.tokenSet ? 'Leave unchanged or enter new token' : 'Paste token'}
            />
          </div>
        </div>

        {connection?.lastError && (
          <p className="text-xs text-red-400">{connection.lastError}</p>
        )}

        {testResult && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs',
              testResult.ok
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-300'
            )}
          >
            <AppIcon icon={testResult.ok ? BadgeCheck : CircleX} size="sm" className="mt-0.5 shrink-0" />
            <span>{testResult.message}</span>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => testMutation.mutate()}
            disabled={
              testMutation.isPending ||
              !token ||
              (token === SECRET_PLACEHOLDER && !connection?.tokenSet) ||
              (tokenType === 'user_api' && !username) ||
              (tokenType === 'workspace_access' && !workspace)
            }
          >
            {testMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <AppIcon icon={Bolt} size="sm" />
            )}
            Test & Connect
          </Button>
          <Button
            size="sm"
            onClick={() => saveConnectionMutation.mutate()}
            disabled={saveConnectionMutation.isPending || (tokenType === 'user_api' && !username)}
          >
            Save credentials
          </Button>
        </div>
      </div>

      {connection?.connected && (
        <>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold">Tracked repositories</p>
              <Button size="sm" onClick={openAddRepo}>
                <AppIcon icon={PlusCircle} size="sm" />
                Add repository
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Add a repo, then click <strong>Clone</strong> once. Scheduled and manual{' '}
              <strong>Pull</strong> runs after the first clone and only executes{' '}
              <code className="text-xs">git pull</code>. Resource change analysis runs in the
              background.
            </p>
            {syncActionMessage && (
              <p className="text-xs text-muted-foreground">{syncActionMessage}</p>
            )}

            {reposLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-blue-500/50" />
              </div>
            ) : repositories.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                No repositories added yet. Add repos that match your ArgoCD application sources.
              </p>
            ) : (
              <div className="space-y-2">
                {repositories.map((repo) => {
                  const syncing = isRepoSyncing(repo);
                  const showClone = !repo.isCloned && repo.syncStatus !== 'pulling';
                  return (
                    <div
                      key={repo.id}
                      className="rounded-xl border border-border bg-secondary/20 px-4 py-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold">{repo.name}</p>
                            <Badge variant={repo.enabled ? 'success' : 'unknown'}>
                              {repo.enabled ? 'Enabled' : 'Disabled'}
                            </Badge>
                            {repo.lastPullStatus === 'error' && (
                              <Badge variant="failed">Sync failed</Badge>
                            )}
                            {syncing && (
                              <Badge variant="progressing">
                                {(activeRepoAction?.id === repo.id &&
                                  activeRepoAction.action === 'clone') ||
                                repo.syncStatus === 'cloning'
                                  ? 'Cloning…'
                                  : 'Pulling…'}
                              </Badge>
                            )}
                          </div>
                          <p className="mt-1 font-mono text-xs text-muted-foreground truncate">
                            {repo.repoUrl}
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Branch: {repo.defaultBranch ?? 'auto-detect'} · Pull every{' '}
                            {formatPullInterval(repo.pullIntervalMin)} · Last pull{' '}
                            {formatRelativeTime(repo.lastPullAt)}
                            {!repo.isCloned && ' · Not cloned yet'}
                            {repo.appSourceCount > 0 && ` · ${repo.appSourceCount} ArgoCD apps linked`}
                          </p>
                          {repo.lastPullError && (
                            <p className="mt-1 text-[11px] text-red-400">{repo.lastPullError}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {showClone ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => cloneRepoMutation.mutate(repo.id)}
                              disabled={syncing}
                            >
                              {syncing ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <AppIcon icon={FileUp} size="sm" />
                              )}
                              Clone
                            </Button>
                          ) : repo.isCloned ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => pullRepoMutation.mutate(repo.id)}
                              disabled={syncing}
                            >
                              {syncing ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <AppIcon icon={RefreshCcw} size="sm" />
                              )}
                              Pull
                            </Button>
                          ) : null}
                          <Button variant="ghost" size="icon" title="Edit" onClick={() => openEditRepo(repo)}>
                            <AppIcon icon={PenLine} size="sm" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Delete"
                            onClick={() => setDeleteRepo(repo)}
                          >
                            <AppIcon icon={Trash2} size="sm" className="text-red-400/70" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border bg-secondary/10">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/20"
              onClick={() => setAppSourcesExpanded((open) => !open)}
              aria-expanded={appSourcesExpanded}
            >
              <div className="flex min-w-0 items-center gap-2">
                <ChevronRight
                  className={cn(
                    'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                    appSourcesExpanded && 'rotate-90'
                  )}
                />
                <p className="text-sm font-semibold">ArgoCD application sources</p>
                {appSources.length > 0 && (
                  <Badge variant="unknown">{appSources.length}</Badge>
                )}
              </div>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {appSourcesExpanded ? 'Collapse' : 'Expand'}
              </span>
            </button>

            {appSourcesExpanded && (
              <div className="space-y-3 border-t border-border px-4 py-4">
                <div className="flex items-center justify-end gap-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => syncSourcesMutation.mutate()}
                    disabled={syncSourcesMutation.isPending}
                  >
                    {syncSourcesMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <AppIcon icon={RefreshCcw} size="sm" />
                    )}
                    Sync from ArgoCD
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Source metadata from ArgoCD manifests: repo URL, path, target revision (branch), and
                  Helm value files. Synced automatically in the background; expand to inspect or
                  trigger a manual sync.
                </p>

                {sourcesLoading ? (
                  <div className="flex justify-center py-6">
                    <Loader2 className="h-5 w-5 animate-spin text-blue-500/50" />
                  </div>
                ) : appSources.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                    No application sources synced yet. They populate after ArgoCD is configured and
                    sync runs.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-border">
                    <table className="w-full min-w-[720px] text-left text-xs">
                      <thead className="border-b border-border bg-secondary/30 text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-medium">Application</th>
                          <th className="px-3 py-2 font-medium">Cluster</th>
                          <th className="px-3 py-2 font-medium">Repo / path</th>
                          <th className="px-3 py-2 font-medium">Branch</th>
                          <th className="px-3 py-2 font-medium">Helm values</th>
                          <th className="px-3 py-2 font-medium">Git repo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {appSources.map((source) => (
                          <tr key={source.id} className="border-b border-border/60 last:border-0">
                            <td className="px-3 py-2 font-medium text-foreground">{source.argocdApp}</td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {source.cluster ?? '—'}
                              {source.namespace ? ` / ${source.namespace}` : ''}
                            </td>
                            <td className="max-w-[220px] truncate px-3 py-2 font-mono text-[10px] text-muted-foreground">
                              {source.repoUrl}
                              {source.repoPath ? ` / ${source.repoPath}` : ''}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {source.targetRevision ?? '—'}
                            </td>
                            <td className="max-w-[140px] truncate px-3 py-2 text-muted-foreground">
                              {source.helmValueFiles.length
                                ? source.helmValueFiles.join(', ')
                                : '—'}
                            </td>
                            <td className="px-3 py-2">
                              {source.gitRepositoryName ? (
                                <Badge variant="success">{source.gitRepositoryName}</Badge>
                              ) : (
                                <Badge variant="unknown">Not linked</Badge>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      <Dialog open={repoDialogOpen} onOpenChange={setRepoDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingRepo ? 'Edit repository' : 'Add repository'}</DialogTitle>
            <DialogDescription>
              {editingRepo
                ? 'Update pull schedule and branch settings.'
                : 'Add a Bitbucket repository to clone and track on schedule.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!editingRepo && (
              <>
                <div className="space-y-2">
                  <Label>Workspace</Label>
                  <Input
                    value={repoForm.workspace}
                    onChange={(e) => setRepoForm((f) => ({ ...f, workspace: e.target.value }))}
                    placeholder="my-workspace"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Repository URL</Label>
                  <Input
                    value={repoForm.repoUrl}
                    onChange={(e) => setRepoForm((f) => ({ ...f, repoUrl: e.target.value }))}
                    placeholder="https://bitbucket.org/my-workspace/my-gitops-repo"
                  />
                </div>
              </>
            )}
            {editingRepo && (
              <div className="rounded-lg border border-border bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
                <p className="font-mono">{editingRepo.repoUrl}</p>
                <p className="mt-1">Workspace: {editingRepo.workspace}</p>
              </div>
            )}
            <div className="space-y-2">
              <Label>Branch (optional)</Label>
              <Input
                value={repoForm.defaultBranch}
                onChange={(e) => setRepoForm((f) => ({ ...f, defaultBranch: e.target.value }))}
                placeholder="main — leave empty to auto-detect"
              />
              <p className="text-[11px] text-muted-foreground">
                When empty, uses the most common ArgoCD target branch or the repo default. Set
                explicitly for full control.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Pull frequency</Label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={1}
                  value={repoForm.intervalValue}
                  onChange={(e) =>
                    setRepoForm((f) => ({
                      ...f,
                      intervalValue: Math.max(1, parseInt(e.target.value, 10) || 1),
                    }))
                  }
                  className="w-24"
                />
                <Select
                  value={repoForm.intervalUnit}
                  onValueChange={(v) => {
                    const newUnit = v as IntervalUnit;
                    const totalMin = intervalToMinutes(repoForm.intervalValue, repoForm.intervalUnit);
                    setRepoForm((f) => ({
                      ...f,
                      intervalUnit: newUnit,
                      intervalValue: displayInUnit(totalMin, newUnit),
                    }));
                  }}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[150]">
                    <SelectItem value="minutes">Minutes</SelectItem>
                    <SelectItem value="hours">Hours</SelectItem>
                    <SelectItem value="days">Days</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Every {formatPullInterval(intervalToMinutes(repoForm.intervalValue, repoForm.intervalUnit))}
              </p>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
              <div>
                <p className="text-sm font-medium">Enabled</p>
                <p className="text-xs text-muted-foreground">Scheduled pulls run when enabled</p>
              </div>
              <Switch
                checked={repoForm.enabled}
                onCheckedChange={(checked) => setRepoForm((f) => ({ ...f, enabled: checked }))}
              />
            </div>
          </div>

          {repoSaveError && (
            <p className="text-xs text-red-400">{repoSaveError}</p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setRepoDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => saveRepoMutation.mutate()}
              disabled={
                saveRepoMutation.isPending ||
                (!editingRepo && (!repoForm.workspace || !repoForm.repoUrl))
              }
            >
              {saveRepoMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {editingRepo ? 'Save changes' : 'Add repository'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteRepo)} onOpenChange={() => setDeleteRepo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete repository</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  Remove <strong className="text-foreground">{deleteRepo?.name}</strong> from
                  tracking?
                </p>
                {deleteRepo?.isCloned && deleteRepo.clonePath && (
                  <p>
                    The local clone at{' '}
                    <code className="rounded bg-secondary px-1 py-0.5 text-xs">
                      {deleteRepo.clonePath}
                    </code>{' '}
                    will be permanently deleted from disk.
                  </p>
                )}
                {!deleteRepo?.isCloned && (
                  <p>No local clone exists — only the registry entry will be removed.</p>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteRepo(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteRepo && deleteRepoMutation.mutate(deleteRepo.id)}
              disabled={deleteRepoMutation.isPending}
            >
              {deleteRepoMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete repository
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

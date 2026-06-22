'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bolt, CirclePlay, ICON_STROKE, Loader2, X } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch } from '@/lib/api-client';
import { cn, parseClusterDisplay } from '@/lib/utils';
import { workloadKey } from '@/lib/workload-utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const NATIVE_SELECT_CLASS =
  'h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500/30';

interface WorkloadOption {
  name: string;
  kind: string;
  replicas?: number;
}

interface InstantScheduleDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function InstantScheduleDrawer({ open, onClose }: InstantScheduleDrawerProps) {
  const [mounted, setMounted] = useState(false);
  const queryClient = useQueryClient();

  const [cluster, setCluster] = useState('');
  const [namespace, setNamespace] = useState('');
  const [workloadKeyValue, setWorkloadKeyValue] = useState('');
  const [targetReplicas, setTargetReplicas] = useState('1');
  const [error, setError] = useState('');

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setError('');
    }
  }, [open]);

  const { data: clustersData, isLoading: clustersLoading } = useQuery({
    queryKey: ['clusters'],
    queryFn: () => apiFetch<{ clusters: { name: string }[] }>('/api/k8s/clusters'),
    enabled: open,
  });

  const { data: nsData, isLoading: nsLoading } = useQuery({
    queryKey: ['namespaces', cluster],
    queryFn: () =>
      apiFetch<{ namespaces: string[] }>(
        `/api/k8s/clusters/${encodeURIComponent(cluster)}/namespaces`
      ),
    enabled: open && Boolean(cluster),
  });

  const { data: workloadsData, isLoading: workloadsLoading } = useQuery({
    queryKey: ['workloads', cluster, namespace],
    queryFn: () =>
      apiFetch<{ workloads: WorkloadOption[] }>(
        `/api/k8s/clusters/${encodeURIComponent(cluster)}/namespaces/${encodeURIComponent(namespace)}/workloads`
      ),
    enabled: open && Boolean(cluster) && Boolean(namespace),
  });

  const clusterOptions = useMemo(
    () => (clustersData?.clusters ?? []).map((c) => c.name),
    [clustersData]
  );

  const namespaceOptions = useMemo(() => nsData?.namespaces ?? [], [nsData]);

  const workloadOptions = useMemo(() => {
    return (workloadsData?.workloads ?? []).filter((w) => w.kind !== 'DaemonSet');
  }, [workloadsData]);

  const selectedWorkload = useMemo(() => {
    if (!workloadKeyValue) return null;
    const [kind, ...rest] = workloadKeyValue.split('::');
    const name = rest.join('::');
    return workloadOptions.find((w) => w.kind === kind && w.name === name) ?? null;
  }, [workloadKeyValue, workloadOptions]);

  const startMutation = useMutation({
    mutationFn: (body: {
      cluster: string;
      namespace: string;
      appName: string;
      workloadKind: string;
      targetReplicas: number;
    }) =>
      apiFetch('/api/instant-schedules', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['instant-schedules'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!cluster || !namespace || !workloadKeyValue) {
      setError('Select cluster, namespace, and workload.');
      return;
    }

    const [kind, ...rest] = workloadKeyValue.split('::');
    const appName = rest.join('::');
    const replicas = Number.parseInt(targetReplicas, 10);
    if (!Number.isFinite(replicas) || replicas < 1) {
      setError('Target replicas must be at least 1.');
      return;
    }

    startMutation.mutate({
      cluster,
      namespace,
      appName,
      workloadKind: kind,
      targetReplicas: replicas,
    });
  }

  if (!open || !mounted) return null;

  const { clusterName } = parseClusterDisplay(cluster);

  return createPortal(
    <div className="fixed inset-0 z-[130] flex justify-end">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={cn(
          'relative z-10 flex h-dvh w-full max-w-md flex-col border-l border-border bg-card shadow-2xl',
          'animate-in slide-in-from-right duration-300'
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby="instant-schedule-drawer-title"
      >
        <div className="sticky top-0 z-20 flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-3">
          <div>
            <h2 id="instant-schedule-drawer-title" className="text-sm font-semibold text-foreground">
              Instant Schedule
            </h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Start one workload now — existing schedules are not changed.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={ICON_STROKE} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 scrollbar-thin">
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200">
              Use this for a short-lived start of a single service (e.g. one app in{' '}
              <span className="font-mono">sit-sms</span> while the namespace schedule is still
              waiting). Stop it here when done — your regular schedules keep their own times.
            </div>

            <div className="space-y-2">
              <Label htmlFor="instant-cluster">Cluster</Label>
              <select
                id="instant-cluster"
                className={NATIVE_SELECT_CLASS}
                value={cluster}
                onChange={(e) => {
                  setCluster(e.target.value);
                  setNamespace('');
                  setWorkloadKeyValue('');
                }}
                required
                disabled={clustersLoading}
              >
                <option value="" disabled>
                  {clustersLoading ? 'Loading…' : 'Select cluster'}
                </option>
                {clusterOptions.map((c) => (
                  <option key={c} value={c}>
                    {parseClusterDisplay(c).clusterName}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="instant-namespace">Namespace</Label>
              <select
                id="instant-namespace"
                className={NATIVE_SELECT_CLASS}
                value={namespace}
                onChange={(e) => {
                  setNamespace(e.target.value);
                  setWorkloadKeyValue('');
                }}
                required
                disabled={!cluster || nsLoading}
              >
                <option value="" disabled>
                  {!cluster ? 'Select cluster first' : nsLoading ? 'Loading…' : 'Select namespace'}
                </option>
                {namespaceOptions.map((ns) => (
                  <option key={ns} value={ns}>
                    {ns}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="instant-workload">Workload</Label>
              <select
                id="instant-workload"
                className={NATIVE_SELECT_CLASS}
                value={workloadKeyValue}
                onChange={(e) => {
                  setWorkloadKeyValue(e.target.value);
                  const [kind, ...rest] = e.target.value.split('::');
                  const name = rest.join('::');
                  const match = workloadOptions.find((w) => w.kind === kind && w.name === name);
                  if (match?.replicas != null && match.replicas > 0) {
                    setTargetReplicas(String(match.replicas));
                  }
                }}
                required
                disabled={!namespace || workloadsLoading}
              >
                <option value="" disabled>
                  {!namespace
                    ? 'Select namespace first'
                    : workloadsLoading
                      ? 'Loading…'
                      : 'Select workload'}
                </option>
                {workloadOptions.map((w) => (
                  <option key={workloadKey(w.kind, w.name)} value={workloadKey(w.kind, w.name)}>
                    {w.name} ({w.kind})
                    {w.replicas != null ? ` · ${w.replicas} replicas` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="instant-replicas">Target replicas</Label>
              <Input
                id="instant-replicas"
                type="number"
                min={1}
                max={100}
                value={targetReplicas}
                onChange={(e) => setTargetReplicas(e.target.value)}
                required
              />
              {selectedWorkload?.replicas != null && (
                <p className="text-[11px] text-muted-foreground">
                  Current desired: {selectedWorkload.replicas} · Stop restores previous count (
                  usually 0 if the namespace is still down).
                </p>
              )}
            </div>

            {cluster && namespace && selectedWorkload && (
              <div className="rounded-xl border border-border bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Preview:</span> Start{' '}
                <span className="font-mono text-foreground">{selectedWorkload.name}</span> in{' '}
                <span className="font-mono text-foreground">{namespace}</span> on{' '}
                <span className="font-mono text-foreground">{clusterName}</span> at{' '}
                {targetReplicas} replica{targetReplicas === '1' ? '' : 's'}.
              </div>
            )}

            {error && (
              <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
          </div>

          <div className="shrink-0 border-t border-border bg-card px-4 py-3">
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                className="flex-1 gap-1.5"
                disabled={startMutation.isPending || !workloadKeyValue}
              >
                {startMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <AppIcon icon={CirclePlay} size="sm" />
                )}
                Start now
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

export interface InstantRunRow {
  id: string;
  cluster: string;
  namespace: string;
  appName: string;
  workloadKind: string;
  replicasBefore: number;
  targetReplicas: number;
  active: boolean;
  startedBy: string;
  startedAt: string;
}

export function ActiveInstantRunsPanel({
  canStop,
  onStartClick,
}: {
  canStop: boolean;
  onStartClick?: () => void;
}) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['instant-schedules'],
    queryFn: () => apiFetch<{ runs: InstantRunRow[] }>('/api/instant-schedules'),
    refetchInterval: 60_000,
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/instant-schedules/${id}/stop`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['instant-schedules'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    },
  });

  const runs = data?.runs ?? [];
  if (!canStop && runs.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border bg-card/60 px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AppIcon icon={Bolt} size="sm" className="text-amber-500" />
          <h2 className="text-sm font-semibold text-foreground">Active instant runs</h2>
          {runs.length > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
              {runs.length}
            </span>
          )}
        </div>
        {canStop && onStartClick && (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={onStartClick}>
            <AppIcon icon={Bolt} size="sm" />
            Instant Schedule
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No workloads running via Instant Schedule. Use Instant Schedule to temporarily start one
          service without changing your existing schedules.
        </p>
      ) : (
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full text-sm table-modern">
            <thead>
              <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                <th className="px-2 py-2 text-left font-medium">Workload</th>
                <th className="px-2 py-2 text-left font-medium">Namespace</th>
                <th className="px-2 py-2 text-left font-medium">Cluster</th>
                <th className="px-2 py-2 text-left font-medium">Replicas</th>
                <th className="px-2 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-border">
                  <td className="px-2 py-3 font-medium text-foreground">
                    {run.appName}
                    <span className="ml-1 text-[10px] text-muted-foreground">({run.workloadKind})</span>
                  </td>
                  <td className="px-2 py-3 font-mono text-xs text-muted-foreground">{run.namespace}</td>
                  <td className="px-2 py-3 text-xs text-muted-foreground">
                    {parseClusterDisplay(run.cluster).clusterName}
                  </td>
                  <td className="px-2 py-3 text-xs tabular-nums">{run.targetReplicas}</td>
                  <td className="px-2 py-3 text-right">
                    {canStop ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-rose-600 hover:text-rose-600 dark:text-rose-400"
                        onClick={() => stopMutation.mutate(run.id)}
                        disabled={stopMutation.isPending}
                      >
                        Stop
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

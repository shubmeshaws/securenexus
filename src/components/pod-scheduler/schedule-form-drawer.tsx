'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, ICON_STROKE } from '@/lib/icons';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiFetch, type Schedule } from '@/lib/api-client';
import { DAY_LABELS, formatTime12h, isOvernightSchedule } from '@/lib/utils';
import {
  defaultOnetimeShutdownInput,
  defaultOnetimeStartupInput,
  formatZonedDatetimeInput,
  type ScheduleRecurrence,
} from '@/lib/schedule-recurrence';
import {
  isNamespaceSchedule,
  NAMESPACE_SCOPE_MARKER,
  parseWorkloadKey,
  workloadKey,
  type ScheduleScope,
  type WorkloadKind,
} from '@/lib/workload-utils';

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'Australia/Sydney',
];

const NATIVE_SELECT_CLASS =
  'flex h-10 w-full appearance-none rounded-xl border border-border bg-background px-4 py-2 text-sm text-foreground transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50';

interface WorkloadOption {
  name: string;
  kind: WorkloadKind;
}

function scheduleToForm(schedule: Schedule | null | undefined) {
  const namespaceScope = schedule ? isNamespaceSchedule(schedule) : false;
  const timezone = schedule?.timezone ?? 'Asia/Kolkata';
  const recurrence = (schedule?.recurrence ?? 'daily') as ScheduleRecurrence;
  const defaultShutdown = defaultOnetimeShutdownInput(timezone);

  if (!schedule) {
    return {
      name: '',
      cluster: '',
      namespace: '',
      scope: 'workload' as ScheduleScope,
      appName: '',
      workloadKind: 'Deployment' as WorkloadKind,
      excludedWorkloads: [] as string[],
      recurrence: 'daily' as ScheduleRecurrence,
      shutdownTime: '20:30',
      startupTime: '08:30',
      oneTimeShutdownAt: defaultShutdown,
      oneTimeStartupAt: defaultOnetimeStartupInput(defaultShutdown, timezone),
      timezone,
      daysOfWeek: [1, 2, 3, 4, 5] as number[],
      syncPolicy: 'automated' as 'automated' | 'none',
      argocdInstanceId: null as string | null,
      targetReplicas: 2,
      enabled: true,
    };
  }

  return {
    name: schedule.name ?? '',
    cluster: schedule.cluster ?? '',
    namespace: schedule.namespace ?? '',
    scope: (namespaceScope ? 'namespace' : 'workload') as ScheduleScope,
    appName: namespaceScope ? '' : (schedule.appName ?? ''),
    workloadKind: (schedule.workloadKind ?? 'Deployment') as WorkloadKind,
    excludedWorkloads: schedule.excludedWorkloads ?? [],
    recurrence,
    shutdownTime: schedule.shutdownTime ?? '20:30',
    startupTime: schedule.startupTime ?? '08:30',
    oneTimeShutdownAt: schedule.oneTimeShutdownAt
      ? formatZonedDatetimeInput(new Date(schedule.oneTimeShutdownAt), timezone)
      : defaultShutdown,
    oneTimeStartupAt: schedule.oneTimeStartupAt
      ? formatZonedDatetimeInput(new Date(schedule.oneTimeStartupAt), timezone)
      : defaultOnetimeStartupInput(defaultShutdown, timezone),
    timezone,
    daysOfWeek: schedule.daysOfWeek ?? [1, 2, 3, 4, 5],
    syncPolicy: schedule.syncPolicy ?? 'automated',
    argocdInstanceId: schedule.argocdInstanceId ?? null,
    targetReplicas: schedule.targetReplicas ?? 2,
    enabled: schedule.enabled ?? true,
  };
}

interface ScheduleFormDrawerProps {
  open: boolean;
  onClose: () => void;
  schedule?: Schedule | null;
}

interface ScheduleFormContentProps {
  schedule?: Schedule | null;
  onClose: () => void;
}

function ScheduleFormContent({ schedule, onClose }: ScheduleFormContentProps) {
  const queryClient = useQueryClient();
  const isEdit = Boolean(schedule);
  const initial = scheduleToForm(schedule);

  const [name, setName] = useState(initial.name);
  const [cluster, setCluster] = useState(initial.cluster);
  const [namespace, setNamespace] = useState(initial.namespace);
  const [scope, setScope] = useState<ScheduleScope>(initial.scope);
  const [appName, setAppName] = useState(initial.appName);
  const [workloadKind, setWorkloadKind] = useState<WorkloadKind>(initial.workloadKind);
  const [excludedWorkloads, setExcludedWorkloads] = useState<string[]>(initial.excludedWorkloads);
  const [recurrence, setRecurrence] = useState<ScheduleRecurrence>(initial.recurrence);
  const [shutdownTime, setShutdownTime] = useState(initial.shutdownTime);
  const [startupTime, setStartupTime] = useState(initial.startupTime);
  const [oneTimeShutdownAt, setOneTimeShutdownAt] = useState(initial.oneTimeShutdownAt);
  const [oneTimeStartupAt, setOneTimeStartupAt] = useState(initial.oneTimeStartupAt);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(initial.daysOfWeek);
  const [syncPolicy, setSyncPolicy] = useState<'automated' | 'none'>(initial.syncPolicy);
  const [argocdInstanceId, setArgoCDInstanceId] = useState<string | null>(initial.argocdInstanceId);
  const [enabled, setEnabled] = useState(initial.enabled);

  const { data: argocdInstancesData } = useQuery({
    queryKey: ['argocd-instances-picker'],
    queryFn: () =>
      apiFetch<{ instances: { id: string; name: string; serverUrl: string }[] }>(
        '/api/argocd/instances'
      ),
    staleTime: 60_000,
  });

  const argocdOptions = argocdInstancesData?.instances ?? [];

  const { data: clustersData } = useQuery({
    queryKey: ['clusters'],
    queryFn: () => apiFetch<{ clusters: { name: string }[] }>('/api/k8s/clusters'),
    staleTime: 60_000,
  });

  const { data: nsData } = useQuery({
    queryKey: ['namespaces', cluster],
    queryFn: () =>
      apiFetch<{ namespaces: string[] }>(
        `/api/k8s/clusters/${encodeURIComponent(cluster)}/namespaces`
      ),
    enabled: Boolean(cluster),
    staleTime: 60_000,
  });

  const { data: workloadsData } = useQuery({
    queryKey: ['workloads', cluster, namespace],
    queryFn: () =>
      apiFetch<{ workloads: WorkloadOption[] }>(
        `/api/k8s/clusters/${encodeURIComponent(cluster)}/namespaces/${encodeURIComponent(namespace)}/workloads`
      ),
    enabled: Boolean(cluster) && Boolean(namespace),
    staleTime: 60_000,
  });

  const clusterOptions = useMemo(() => {
    const options = new Set((clustersData?.clusters ?? []).map((c) => c.name));
    if (cluster) options.add(cluster);
    return Array.from(options);
  }, [clustersData, cluster]);

  const namespaceOptions = useMemo(() => {
    const options = new Set(nsData?.namespaces ?? []);
    if (namespace) options.add(namespace);
    return Array.from(options);
  }, [nsData, namespace]);

  const workloadOptions = useMemo(() => {
    const fromApi = workloadsData?.workloads ?? [];
    if (!appName || scope === 'namespace') return fromApi;
    const exists = fromApi.some((w) => w.name === appName && w.kind === workloadKind);
    if (exists) return fromApi;
    return [{ name: appName, kind: workloadKind }, ...fromApi];
  }, [workloadsData, appName, workloadKind, scope]);

  const scalableWorkloads = useMemo(
    () => workloadOptions.filter((w) => w.kind !== 'DaemonSet'),
    [workloadOptions]
  );

  useEffect(() => {
    if (scope !== 'workload' || !appName || !workloadsData?.workloads?.length) return;
    const match = workloadsData.workloads.find((w) => w.name === appName);
    if (match) setWorkloadKind(match.kind);
  }, [workloadsData, appName, scope]);

  const workloadValue = appName ? workloadKey(workloadKind, appName) : '';

  function toggleExcluded(key: string) {
    setExcludedWorkloads((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key].sort()
    );
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const shared = {
        name,
        cluster,
        namespace,
        scope,
        appName: scope === 'namespace' ? NAMESPACE_SCOPE_MARKER : appName,
        workloadKind: scope === 'namespace' ? 'Namespace' : workloadKind,
        excludedWorkloads: scope === 'namespace' ? excludedWorkloads : [],
        timezone,
        syncPolicy,
        argocdInstanceId,
        targetReplicas: schedule?.targetReplicas ?? 2,
        enabled,
        recurrence,
      };

      const body =
        recurrence === 'onetime'
          ? {
              ...shared,
              oneTimeShutdownAt,
              oneTimeStartupAt,
            }
          : {
              ...shared,
              shutdownTime,
              startupTime,
              daysOfWeek,
            };
      if (isEdit && schedule) {
        return apiFetch(`/api/schedules/${schedule.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      }
      return apiFetch('/api/schedules', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      onClose();
    },
  });

  function toggleDay(day: number) {
    setDaysOfWeek((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()
    );
  }

  return (
    <form
      className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      <div className="space-y-2">
        <Label>Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Business hours shutdown" />
      </div>

      <div className="space-y-2">
        <Label>Schedule type</Label>
        <div className="grid grid-cols-2 gap-2">
          {(['daily', 'onetime'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setRecurrence(mode)}
              className={cn(
                'rounded-xl border px-3 py-2.5 text-left text-xs transition-colors',
                recurrence === mode
                  ? 'border-blue-500/40 bg-blue-500/10 text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:border-border/80'
              )}
            >
              <span className="block font-medium">
                {mode === 'daily' ? 'Daily' : 'One-time'}
              </span>
              <span className="mt-0.5 block text-[10px] opacity-80">
                {mode === 'daily'
                  ? 'Repeats on selected days every week'
                  : 'Runs shutdown and startup once on chosen dates'}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label>Cluster</Label>
        <select
          className={NATIVE_SELECT_CLASS}
          value={cluster}
          onChange={(e) => {
            setCluster(e.target.value);
            setNamespace('');
            setAppName('');
            setWorkloadKind('Deployment');
            setExcludedWorkloads([]);
          }}
        >
          <option value="" disabled>
            Select cluster
          </option>
          {clusterOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label>Namespace</Label>
        <select
          className={NATIVE_SELECT_CLASS}
          value={namespace}
          disabled={!cluster}
          onChange={(e) => {
            setNamespace(e.target.value);
            setAppName('');
            setWorkloadKind('Deployment');
            setExcludedWorkloads([]);
          }}
        >
          <option value="" disabled>
            Select namespace
          </option>
          {namespaceOptions.map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label>Schedule scope</Label>
        <select
          className={NATIVE_SELECT_CLASS}
          value={scope}
          disabled={!namespace}
          onChange={(e) => {
            const next = e.target.value as ScheduleScope;
            setScope(next);
            if (next === 'namespace') {
              setAppName('');
              setWorkloadKind('Deployment');
            } else {
              setExcludedWorkloads([]);
            }
          }}
        >
          <option value="workload">Single workload</option>
          <option value="namespace">Entire namespace</option>
        </select>
      </div>

      {scope === 'workload' ? (
        <div className="space-y-2">
          <Label>Workload</Label>
          <select
            className={NATIVE_SELECT_CLASS}
            value={workloadValue}
            disabled={!namespace}
            onChange={(e) => {
              const parsed = parseWorkloadKey(e.target.value);
              if (!parsed) return;
              setAppName(parsed.name);
              setWorkloadKind(parsed.kind);
            }}
          >
            <option value="" disabled>
              Select workload
            </option>
            {workloadOptions.map((w) => (
              <option key={workloadKey(w.kind, w.name)} value={workloadKey(w.kind, w.name)}>
                {w.name} ({w.kind})
              </option>
            ))}
          </select>
          {appName && (
            <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
              Kind
              <Badge variant="secondary" className="font-mono text-[10px]">
                {workloadKind}
              </Badge>
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <Label>Exclude workloads (optional)</Label>
          <p className="text-[10px] text-muted-foreground">
            All Deployments and StatefulSets in the namespace will be scheduled. Uncheck any to exclude. DaemonSets are always skipped.
          </p>
          {!namespace ? (
            <p className="text-xs text-muted-foreground">Select a namespace first.</p>
          ) : scalableWorkloads.length === 0 ? (
            <p className="text-xs text-muted-foreground">No scalable workloads found in this namespace.</p>
          ) : (
            <div className="max-h-40 space-y-2 overflow-y-auto rounded-xl border border-border p-3 scrollbar-thin">
              {scalableWorkloads.map((w) => {
                const key = workloadKey(w.kind, w.name);
                const excluded = excludedWorkloads.includes(key);
                return (
                  <label
                    key={key}
                    className="flex items-center gap-2 text-xs text-foreground/90"
                  >
                    <Checkbox
                      checked={!excluded}
                      onCheckedChange={() => toggleExcluded(key)}
                    />
                    <span className="font-mono">{w.name}</span>
                    <Badge variant="secondary" className="font-mono text-[9px]">
                      {w.kind}
                    </Badge>
                  </label>
                );
              })}
            </div>
          )}
          {excludedWorkloads.length > 0 && (
            <p className="text-[10px] text-muted-foreground">
              {excludedWorkloads.length} workload(s) excluded
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        <Label>Timezone</Label>
        <Select
          value={timezone}
          onValueChange={(value) => {
            setTimezone(value);
            if (recurrence === 'onetime') {
              const shutdown = defaultOnetimeShutdownInput(value);
              setOneTimeShutdownAt(shutdown);
              setOneTimeStartupAt(defaultOnetimeStartupInput(shutdown, value));
            }
          }}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent className="z-[150]">
            {TIMEZONES.map((tz) => (
              <SelectItem key={tz} value={tz}>{tz}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {recurrence === 'daily' ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Shutdown</Label>
              <Input type="time" value={shutdownTime} onChange={(e) => setShutdownTime(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Startup</Label>
              <Input type="time" value={startupTime} onChange={(e) => setStartupTime(e.target.value)} />
            </div>
          </div>

          {isOvernightSchedule(shutdownTime, startupTime) ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
              Overnight window: workloads stop at {formatTime12h(shutdownTime)} and start the{' '}
              <strong>next day</strong> at {formatTime12h(startupTime)}. To restart a few minutes after
              shutdown (like a short break), set startup to a later <strong>PM</strong> time — e.g.{' '}
              {formatTime12h(
                `${String(Math.min(23, Number(shutdownTime.split(':')[0]) + 1)).padStart(2, '0')}:${shutdownTime.split(':')[1] ?? '00'}`
              )}
              .
            </p>
          ) : null}

          <div className="space-y-2">
            <Label>Days of week</Label>
            <div className="flex flex-wrap gap-3">
              {DAY_LABELS.map((label, i) => {
                const day = i + 1;
                return (
                  <label key={day} className="flex items-center gap-1.5 text-xs text-foreground/80">
                    <Checkbox checked={daysOfWeek.includes(day)} onCheckedChange={() => toggleDay(day)} />
                    {label}
                  </label>
                );
              })}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label>Shutdown date & time</Label>
            <Input
              type="datetime-local"
              value={oneTimeShutdownAt}
              onChange={(e) => {
                setOneTimeShutdownAt(e.target.value);
                if (oneTimeStartupAt <= e.target.value) {
                  setOneTimeStartupAt(defaultOnetimeStartupInput(e.target.value, timezone));
                }
              }}
              required
            />
          </div>
          <div className="space-y-2">
            <Label>Startup date & time</Label>
            <Input
              type="datetime-local"
              value={oneTimeStartupAt}
              min={oneTimeShutdownAt}
              onChange={(e) => setOneTimeStartupAt(e.target.value)}
              required
            />
          </div>
          <p className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-muted-foreground">
            This schedule runs once: shutdown at the first datetime, then startup at the second.
            It is disabled automatically after startup completes.
          </p>
        </>
      )}

      <div className="space-y-2">
        <Label>ArgoCD instance</Label>
        <Select
          value={argocdInstanceId ?? '__auto__'}
          onValueChange={(value) => setArgoCDInstanceId(value === '__auto__' ? null : value)}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select ArgoCD" />
          </SelectTrigger>
          <SelectContent className="z-[150]">
            <SelectItem value="__auto__">Auto — match by cluster</SelectItem>
            {argocdOptions.map((instance) => (
              <SelectItem key={instance.id} value={instance.id}>
                {instance.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground">
          {argocdOptions.length === 0
            ? 'No ArgoCD instances configured. Add them in Admin → Settings.'
            : 'Choose which ArgoCD server manages sync for this schedule.'}
        </p>
      </div>

      <div className="flex items-center justify-between rounded-xl border border-border p-3">
        <div>
          <Label>Restore ArgoCD sync on startup</Label>
          <p className="mt-0.5 text-[10px] text-muted-foreground">Re-enable automated sync when scaling up</p>
        </div>
        <Switch
          checked={syncPolicy === 'automated'}
          onCheckedChange={(c) => setSyncPolicy(c ? 'automated' : 'none')}
        />
      </div>

      <div className="flex items-center justify-between">
        <Label>Enabled</Label>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {mutation.isError && (
        <p className="text-xs text-red-400">{(mutation.error as Error).message}</p>
      )}

      <div className="flex gap-2 pt-2">
        <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" className="flex-1" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving...' : isEdit ? 'Update' : 'Create'}
        </Button>
      </div>
    </form>
  );
}

export function ScheduleFormDrawer({ open, onClose, schedule }: ScheduleFormDrawerProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || !mounted) return null;

  const formKey = schedule?.id ?? 'new';

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
        aria-labelledby="schedule-drawer-title"
      >
        <div className="sticky top-0 z-20 flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-3">
          <h2 id="schedule-drawer-title" className="text-sm font-semibold text-foreground">
            {schedule ? 'Edit Schedule' : 'Add Schedule'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="relative z-20 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={ICON_STROKE} />
          </button>
        </div>

        <ScheduleFormContent key={formKey} schedule={schedule} onClose={onClose} />
      </div>
    </div>,
    document.body
  );
}

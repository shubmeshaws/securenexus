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
  type PlatformType,
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

interface AwsCredentialOption {
  id: string;
  name: string;
  defaultRegion: string;
  awsAccountId: string | null;
  iamRoleName: string | null;
}

interface Ec2InstanceOption {
  instanceId: string;
  name: string;
  region: string;
  state: string;
  instanceType: string;
}

const EC2_SELECT_SEP = '§';

function ec2SelectValue(instanceId: string, region: string): string {
  return `${instanceId}${EC2_SELECT_SEP}${region}`;
}

function parseEc2SelectValue(value: string): { instanceId: string; region: string } | null {
  const sep = value.indexOf(EC2_SELECT_SEP);
  if (sep <= 0) return null;
  return { instanceId: value.slice(0, sep), region: value.slice(sep + 1) };
}

interface WorkloadOption {
  name: string;
  kind: WorkloadKind;
}

function scheduleToForm(schedule: Schedule | null | undefined) {
  const namespaceScope = schedule ? isNamespaceSchedule(schedule) : false;
  const timezone = schedule?.timezone ?? 'Asia/Kolkata';
  const recurrence = (schedule?.recurrence ?? 'daily') as ScheduleRecurrence;
  const defaultShutdown = defaultOnetimeShutdownInput(timezone);
  const platformType = (schedule?.platformType ?? 'eks') as PlatformType;

  if (!schedule) {
    return {
      name: '',
      platformType: 'eks' as PlatformType,
      cluster: '',
      namespace: '',
      scope: 'workload' as ScheduleScope,
      appName: '',
      workloadKind: 'Deployment' as WorkloadKind,
      excludedWorkloads: [] as string[],
      awsCredentialId: '',
      ec2InstanceId: '',
      ec2Region: '',
      recurrence: 'daily' as ScheduleRecurrence,
      shutdownTime: '20:30',
      startupTime: '08:30',
      weekendShutdownTime: '20:30',
      weekendStartupTime: '10:30',
      oneTimeShutdownAt: defaultShutdown,
      oneTimeStartupAt: defaultOnetimeStartupInput(defaultShutdown, timezone),
      timezone,
      daysOfWeek: [1, 2, 3, 4, 5] as number[],
      weekdayDays: [1, 2, 3, 4, 5] as number[],
      weekendDays: [6, 7] as number[],
      syncPolicy: 'automated' as 'automated' | 'none',
      argocdInstanceId: null as string | null,
      targetReplicas: 2,
      enabled: true,
      teamsAlertEnabled: true,
    };
  }

  return {
    name: schedule.name ?? '',
    platformType,
    cluster: schedule.cluster ?? '',
    namespace: schedule.namespace ?? '',
    scope: (namespaceScope ? 'namespace' : 'workload') as ScheduleScope,
    appName: namespaceScope ? '' : (schedule.appName ?? ''),
    workloadKind: (schedule.workloadKind ?? 'Deployment') as WorkloadKind,
    excludedWorkloads: schedule.excludedWorkloads ?? [],
    awsCredentialId: schedule.awsCredentialId ?? '',
    ec2InstanceId: schedule.ec2InstanceId ?? '',
    ec2Region: schedule.ec2Region ?? '',
    recurrence,
    shutdownTime: schedule.shutdownTime ?? '20:30',
    startupTime: schedule.startupTime ?? '08:30',
    weekendShutdownTime: schedule.weekendShutdownTime ?? '20:30',
    weekendStartupTime: schedule.weekendStartupTime ?? '10:30',
    oneTimeShutdownAt: schedule.oneTimeShutdownAt
      ? formatZonedDatetimeInput(new Date(schedule.oneTimeShutdownAt), timezone)
      : defaultShutdown,
    oneTimeStartupAt: schedule.oneTimeStartupAt
      ? formatZonedDatetimeInput(new Date(schedule.oneTimeStartupAt), timezone)
      : defaultOnetimeStartupInput(defaultShutdown, timezone),
    timezone,
    daysOfWeek: schedule.daysOfWeek ?? [1, 2, 3, 4, 5],
    weekdayDays: (schedule.daysOfWeek ?? [1, 2, 3, 4, 5]).filter(
      (d) => !(schedule.weekendDays ?? []).includes(d)
    ),
    weekendDays:
      schedule.weekendDays && schedule.weekendDays.length
        ? schedule.weekendDays
        : recurrence === 'split'
          ? [6, 7]
          : [],
    syncPolicy: schedule.syncPolicy ?? 'automated',
    argocdInstanceId: schedule.argocdInstanceId ?? null,
    targetReplicas: schedule.targetReplicas ?? 2,
    enabled: schedule.enabled ?? true,
    teamsAlertEnabled: schedule.teamsAlertEnabled ?? true,
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
  const [platformType, setPlatformType] = useState<PlatformType>(initial.platformType);
  const [cluster, setCluster] = useState(initial.cluster);
  const [namespace, setNamespace] = useState(initial.namespace);
  const [scope, setScope] = useState<ScheduleScope>(initial.scope);
  const [appName, setAppName] = useState(initial.appName);
  const [workloadKind, setWorkloadKind] = useState<WorkloadKind>(initial.workloadKind);
  const [excludedWorkloads, setExcludedWorkloads] = useState<string[]>(initial.excludedWorkloads);
  const [awsCredentialId, setAwsCredentialId] = useState(initial.awsCredentialId);
  const [ec2InstanceId, setEc2InstanceId] = useState(initial.ec2InstanceId);
  const [ec2Region, setEc2Region] = useState(initial.ec2Region);
  const [ec2Scope, setEc2Scope] = useState<'single' | 'multiple'>('single');
  const [selectedEc2Instances, setSelectedEc2Instances] = useState<string[]>(
    initial.ec2InstanceId && initial.ec2Region
      ? [ec2SelectValue(initial.ec2InstanceId, initial.ec2Region)]
      : []
  );
  const [recurrence, setRecurrence] = useState<ScheduleRecurrence>(initial.recurrence);
  const [shutdownTime, setShutdownTime] = useState(initial.shutdownTime);
  const [startupTime, setStartupTime] = useState(initial.startupTime);
  const [weekendShutdownTime, setWeekendShutdownTime] = useState(initial.weekendShutdownTime);
  const [weekendStartupTime, setWeekendStartupTime] = useState(initial.weekendStartupTime);
  const [oneTimeShutdownAt, setOneTimeShutdownAt] = useState(initial.oneTimeShutdownAt);
  const [oneTimeStartupAt, setOneTimeStartupAt] = useState(initial.oneTimeStartupAt);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(initial.daysOfWeek);
  const [weekendDays, setWeekendDays] = useState<number[]>(initial.weekendDays);
  const [weekdayDays, setWeekdayDays] = useState<number[]>(initial.weekdayDays);
  const [syncPolicy, setSyncPolicy] = useState<'automated' | 'none'>(initial.syncPolicy);
  const [argocdInstanceId, setArgoCDInstanceId] = useState<string | null>(initial.argocdInstanceId);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [teamsAlertEnabled, setTeamsAlertEnabled] = useState(initial.teamsAlertEnabled);

  const { data: argocdInstancesData } = useQuery({
    queryKey: ['argocd-instances-picker'],
    queryFn: () =>
      apiFetch<{ instances: { id: string; name: string; serverUrl: string }[] }>(
        '/api/argocd/instances'
      ),
    staleTime: 60_000,
  });

  const argocdOptions = argocdInstancesData?.instances ?? [];

  const { data: awsCredsData } = useQuery({
    queryKey: ['aws-credentials-picker'],
    queryFn: () =>
      apiFetch<{ credentials: AwsCredentialOption[] }>('/api/aws-credentials'),
    staleTime: 60_000,
  });

  const awsCredentialOptions = awsCredsData?.credentials ?? [];
  const hasAwsCredentials = awsCredentialOptions.length > 0;
  const selectedAwsCred = awsCredentialOptions.find((c) => c.id === awsCredentialId);

  const { data: ec2Data, isLoading: ec2Loading, isFetching: ec2Fetching } = useQuery({
    queryKey: ['ec2-instances', awsCredentialId],
    queryFn: () =>
      apiFetch<{ instances: Ec2InstanceOption[] }>(
        `/api/aws-credentials/${encodeURIComponent(awsCredentialId)}/instances`
      ),
    enabled: platformType === 'non_eks' && Boolean(awsCredentialId),
    staleTime: 5 * 60_000,
    placeholderData: (previousData) => previousData,
  });

  const ec2Options = ec2Data?.instances ?? [];
  const ec2SelectValueCurrent =
    ec2InstanceId && ec2Region ? ec2SelectValue(ec2InstanceId, ec2Region) : '';

  const { data: clustersData, isLoading: clustersLoading } = useQuery({
    queryKey: ['clusters'],
    queryFn: () => apiFetch<{ clusters: { name: string }[] }>('/api/k8s/clusters'),
    staleTime: 60_000,
  });

  const { data: nsData, isLoading: nsLoading, isFetching: nsFetching } = useQuery({
    queryKey: ['namespaces', cluster],
    queryFn: () =>
      apiFetch<{
        namespaces: string[];
        source?: 'k8s' | 'fallback' | 'error';
        warning?: string;
      }>(`/api/k8s/clusters/${encodeURIComponent(cluster)}/namespaces`),
    enabled: platformType === 'eks' && Boolean(cluster),
    staleTime: 60_000,
    placeholderData: (previousData) => previousData,
  });

  const namespaceSource = nsData?.source;
  const namespaceWarning = nsData?.warning;
  const namespaceLiveUnavailable = Boolean(cluster) && namespaceSource && namespaceSource !== 'k8s';

  const clusterTest = useMutation({
    mutationFn: () =>
      apiFetch<{
        ok: boolean;
        namespaceCount?: number;
        durationMs: number;
        error?: string;
        hint?: string;
      }>(`/api/k8s/clusters/${encodeURIComponent(cluster)}/test`),
    onSuccess: (result) => {
      if (result.ok) {
        queryClient.invalidateQueries({ queryKey: ['namespaces', cluster] });
        queryClient.invalidateQueries({ queryKey: ['workloads', cluster] });
      }
    },
  });

  const { data: workloadsData, isLoading: workloadsLoading } = useQuery({
    queryKey: ['workloads', cluster, namespace],
    queryFn: () =>
      apiFetch<{ workloads: WorkloadOption[] }>(
        `/api/k8s/clusters/${encodeURIComponent(cluster)}/namespaces/${encodeURIComponent(namespace)}/workloads`
      ),
    enabled: platformType === 'eks' && Boolean(cluster) && Boolean(namespace),
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

  function toggleEc2Instance(value: string) {
    setSelectedEc2Instances((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value].sort()
    );
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const isNonEks = platformType === 'non_eks';
      const credName = selectedAwsCred?.name ?? cluster;

      const shared = {
        name,
        platformType,
        cluster: isNonEks ? credName : cluster,
        namespace: isNonEks ? ec2Region : namespace,
        scope: isNonEks ? ('workload' as const) : scope,
        appName: isNonEks ? appName : scope === 'namespace' ? NAMESPACE_SCOPE_MARKER : appName,
        workloadKind: isNonEks ? 'EC2' : scope === 'namespace' ? 'Namespace' : workloadKind,
        excludedWorkloads: isNonEks ? [] : scope === 'namespace' ? excludedWorkloads : [],
        awsCredentialId: isNonEks ? awsCredentialId : null,
        ec2InstanceId: isNonEks ? ec2InstanceId : null,
        ec2Region: isNonEks ? ec2Region : null,
        timezone,
        syncPolicy: isNonEks ? ('none' as const) : syncPolicy,
        argocdInstanceId: isNonEks ? null : argocdInstanceId,
        targetReplicas: schedule?.targetReplicas ?? 2,
        enabled,
        teamsAlertEnabled,
        recurrence,
      };

      const body =
        recurrence === 'onetime'
          ? {
              ...shared,
              oneTimeShutdownAt,
              oneTimeStartupAt,
            }
          : recurrence === 'split'
            ? {
                ...shared,
                shutdownTime,
                startupTime,
                weekendShutdownTime,
                weekendStartupTime,
                daysOfWeek: Array.from(new Set([...weekdayDays, ...weekendDays])).sort(
                  (a, b) => a - b
                ),
                weekendDays,
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

      if (isNonEks && ec2Scope === 'multiple') {
        const targets = selectedEc2Instances
          .map((value) => parseEc2SelectValue(value))
          .filter((parsed): parsed is { instanceId: string; region: string } => Boolean(parsed));

        if (!targets.length) {
          throw new Error('Select at least one EC2 instance');
        }

        for (const parsed of targets) {
          const match = ec2Options.find(
            (i) => i.instanceId === parsed.instanceId && i.region === parsed.region
          );
          const instanceLabel = match?.name ?? parsed.instanceId;
          await apiFetch('/api/schedules', {
            method: 'POST',
            body: JSON.stringify({
              ...body,
              name: targets.length === 1 ? name : `${name} · ${instanceLabel}`,
              namespace: parsed.region,
              appName: instanceLabel,
              ec2InstanceId: parsed.instanceId,
              ec2Region: parsed.region,
            }),
          });
        }
        return { created: targets.length };
      }

      return apiFetch('/api/schedules', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      queryClient.invalidateQueries({ queryKey: ['schedules-live'] });
      onClose();
    },
  });

  function toggleDay(day: number) {
    setDaysOfWeek((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()
    );
  }

  // Split mode: a day belongs to either the weekday window or the weekend
  // window (mutually exclusive). Toggling a day in one group clears it from the other.
  function toggleWeekdayDay(day: number) {
    setWeekendDays((prev) => prev.filter((d) => d !== day));
    setWeekdayDays((prev) =>
      prev.includes(day)
        ? prev.filter((d) => d !== day)
        : [...prev, day].sort((a, b) => a - b)
    );
  }

  function toggleWeekendDay(day: number) {
    setWeekdayDays((prev) => prev.filter((d) => d !== day));
    setWeekendDays((prev) =>
      prev.includes(day)
        ? prev.filter((d) => d !== day)
        : [...prev, day].sort((a, b) => a - b)
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
        <div className="grid grid-cols-1 gap-2">
          {(
            [
              {
                mode: 'daily',
                title: 'Daily',
                desc: 'Same times on every selected day each week',
              },
              {
                mode: 'split',
                title: 'Weekday + Weekend',
                desc: 'Two day groups with their own times (pick the days for each)',
              },
              {
                mode: 'onetime',
                title: 'One-time',
                desc: 'Runs shutdown and startup once on chosen dates',
              },
            ] as const
          ).map(({ mode, title, desc }) => (
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
              <span className="block font-medium">{title}</span>
              <span className="mt-0.5 block text-[10px] opacity-80">{desc}</span>
            </button>
          ))}
        </div>
      </div>

      {hasAwsCredentials && (
        <div className="space-y-2">
          <Label>Platform</Label>
          <div className="grid grid-cols-2 gap-2">
            {(['eks', 'non_eks'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  setPlatformType(mode);
                  if (mode === 'non_eks') {
                    setScope('workload');
                    setExcludedWorkloads([]);
                    setEc2Scope('single');
                    setSelectedEc2Instances([]);
                  }
                }}
                className={cn(
                  'rounded-xl border px-3 py-2.5 text-left text-xs transition-colors',
                  platformType === mode
                    ? 'border-blue-500/40 bg-blue-500/10 text-foreground'
                    : 'border-border bg-background text-muted-foreground hover:border-border/80'
                )}
              >
                <span className="block font-medium">{mode === 'eks' ? 'EKS' : 'Non EKS'}</span>
                <span className="mt-0.5 block text-[10px] opacity-80">
                  {mode === 'eks'
                    ? 'Scale Kubernetes workloads on a cluster'
                    : 'Stop and start EC2 instances via AWS'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {platformType === 'non_eks' ? (
        <>
          <div className="space-y-2">
            <Label>AWS account</Label>
            <select
              className={NATIVE_SELECT_CLASS}
              value={awsCredentialId}
              onChange={(e) => {
                setAwsCredentialId(e.target.value);
                setEc2InstanceId('');
                setEc2Region('');
                setAppName('');
                setSelectedEc2Instances([]);
              }}
              required
            >
              <option value="" disabled>
                Select AWS account
              </option>
              {awsCredentialOptions.map((cred) => (
                <option key={cred.id} value={cred.id}>
                  {cred.name}
                  {cred.awsAccountId ? ` (${cred.awsAccountId})` : ''}
                </option>
              ))}
            </select>
            {selectedAwsCred && (
              <p className="text-[10px] text-muted-foreground">
                AWS account ID:{' '}
                <span className="font-mono text-foreground">
                  {selectedAwsCred.awsAccountId ?? 'Save and test this account in Settings to capture'}
                </span>
                {selectedAwsCred.iamRoleName ? (
                  <>
                    {' '}
                    · Role:{' '}
                    <span className="font-mono text-foreground">{selectedAwsCred.iamRoleName}</span>
                  </>
                ) : null}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Instance scope</Label>
            <select
              className={NATIVE_SELECT_CLASS}
              value={ec2Scope}
              disabled={isEdit}
              onChange={(e) => {
                const next = e.target.value as 'single' | 'multiple';
                setEc2Scope(next);
                setEc2InstanceId('');
                setEc2Region('');
                setAppName('');
                setSelectedEc2Instances([]);
              }}
            >
              <option value="single">Single instance</option>
              <option value="multiple">Multiple instances</option>
            </select>
            {isEdit ? (
              <p className="text-[10px] text-muted-foreground">
                Edit applies to this schedule only. Create a new schedule to add more instances.
              </p>
            ) : null}
          </div>

          {ec2Scope === 'single' ? (
          <div className="space-y-2">
            <Label>Instance name</Label>
            <select
              className={NATIVE_SELECT_CLASS}
              value={ec2SelectValueCurrent}
              disabled={!awsCredentialId || ec2Loading}
              onChange={(e) => {
                const parsed = parseEc2SelectValue(e.target.value);
                if (!parsed) return;
                const match = ec2Options.find(
                  (i) => i.instanceId === parsed.instanceId && i.region === parsed.region
                );
                setEc2InstanceId(parsed.instanceId);
                setEc2Region(parsed.region);
                setAppName(match?.name ?? parsed.instanceId);
              }}
              required
            >
              <option value="" disabled>
                {ec2Loading && !ec2Options.length ? 'Loading instances…' : 'Select EC2 instance'}
              </option>
              {ec2Options.map((instance) => (
                <option
                  key={ec2SelectValue(instance.instanceId, instance.region)}
                  value={ec2SelectValue(instance.instanceId, instance.region)}
                >
                  {instance.name} · {instance.region} · {instance.state} ({instance.instanceType})
                </option>
              ))}
            </select>
            {ec2Fetching && ec2Options.length > 0 ? (
              <p className="text-[10px] text-muted-foreground">Refreshing instance list…</p>
            ) : null}
            {awsCredentialId && !ec2Loading && ec2Options.length === 0 && (
              <p className="text-[10px] text-muted-foreground">
                No standalone EC2 instances found in the default region. EKS nodes (tags eks:cluster-name, eks:eks-cluster-name) are excluded.
              </p>
            )}
          </div>
          ) : (
          <div className="space-y-2">
            <Label>Instances</Label>
            <p className="text-[10px] text-muted-foreground">
              Creates one schedule per selected instance with the same timing settings.
            </p>
            {!awsCredentialId ? (
              <p className="text-xs text-muted-foreground">Select an AWS account first.</p>
            ) : ec2Loading && !ec2Options.length ? (
              <p className="text-xs text-muted-foreground">Loading instances…</p>
            ) : ec2Options.length === 0 ? (
              <p className="text-[10px] text-muted-foreground">
                No standalone EC2 instances found. EKS nodes (tags eks:cluster-name, eks:eks-cluster-name) are excluded.
              </p>
            ) : (
              <div className="max-h-48 space-y-2 overflow-y-auto rounded-xl border border-border p-3 scrollbar-thin">
                {ec2Options.map((instance) => {
                  const value = ec2SelectValue(instance.instanceId, instance.region);
                  const checked = selectedEc2Instances.includes(value);
                  return (
                    <label
                      key={value}
                      className="flex items-start gap-2 text-xs text-foreground/90"
                    >
                      <Checkbox checked={checked} onCheckedChange={() => toggleEc2Instance(value)} />
                      <span>
                        <span className="font-medium">{instance.name}</span>
                        <span className="block font-mono text-[10px] text-muted-foreground">
                          {instance.region} · {instance.state} · {instance.instanceType}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {selectedEc2Instances.length > 0 && (
              <p className="text-[10px] text-muted-foreground">
                {selectedEc2Instances.length} instance(s) selected
              </p>
            )}
          </div>
          )}
        </>
      ) : (
        <>
      <div className="space-y-2">
        <Label>Cluster</Label>
        <select
          className={NATIVE_SELECT_CLASS}
          value={cluster}
          disabled={clustersLoading && !clusterOptions.length}
          onChange={(e) => {
            setCluster(e.target.value);
            setNamespace('');
            setAppName('');
            setWorkloadKind('Deployment');
            setExcludedWorkloads([]);
            clusterTest.reset();
          }}
        >
          <option value="" disabled>
            {clustersLoading && !clusterOptions.length ? 'Loading clusters…' : 'Select cluster'}
          </option>
          {clusterOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {!clustersLoading && clusterOptions.length === 0 && (
          <p className="text-[10px] text-muted-foreground">
            No clusters registered yet. Add one under Clusters first.
          </p>
        )}
        {cluster && (
          <div className="space-y-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              disabled={clusterTest.isPending}
              onClick={() => clusterTest.mutate()}
            >
              {clusterTest.isPending ? 'Testing connection…' : 'Test connection'}
            </Button>
            {clusterTest.data?.ok ? (
              <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[10px] leading-relaxed text-emerald-700 dark:text-emerald-300">
                Connected — listed {clusterTest.data.namespaceCount} namespace(s) in{' '}
                {(clusterTest.data.durationMs / 1000).toFixed(1)}s. Reopen the namespace dropdown to
                load the live list.
              </p>
            ) : clusterTest.data && !clusterTest.data.ok ? (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[10px] leading-relaxed text-red-700 dark:text-red-300">
                Connection failed after {(clusterTest.data.durationMs / 1000).toFixed(1)}s:{' '}
                {clusterTest.data.error}
                {clusterTest.data.hint ? <span className="block mt-1 opacity-90">{clusterTest.data.hint}</span> : null}
              </p>
            ) : clusterTest.isError ? (
              <p className="text-[10px] text-red-500">{(clusterTest.error as Error).message}</p>
            ) : null}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label>Namespace</Label>
        <select
          className={NATIVE_SELECT_CLASS}
          value={namespace}
          disabled={!cluster || (nsLoading && !namespaceOptions.length)}
          onChange={(e) => {
            setNamespace(e.target.value);
            setAppName('');
            setWorkloadKind('Deployment');
            setExcludedWorkloads([]);
          }}
        >
          <option value="" disabled>
            {!cluster
              ? 'Select cluster first'
              : nsLoading && !namespaceOptions.length
                ? 'Loading namespaces…'
                : 'Select namespace'}
          </option>
          {namespaceOptions.map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </select>
        {nsFetching && namespaceOptions.length > 0 ? (
          <p className="text-[10px] text-muted-foreground">Refreshing namespaces…</p>
        ) : null}
        {namespaceLiveUnavailable ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-amber-900 dark:text-amber-200">
            {namespaceWarning ??
              'Live cluster API unavailable — showing namespaces from saved schedules and audit history only.'}{' '}
            The SecureNexus server may not be able to reach this cluster (check VPN/network and the
            cluster credentials). Workloads may also be empty until the connection is restored.
          </p>
        ) : null}
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
            disabled={!namespace || (workloadsLoading && !workloadOptions.length)}
            onChange={(e) => {
              const parsed = parseWorkloadKey(e.target.value);
              if (!parsed) return;
              setAppName(parsed.name);
              setWorkloadKind(parsed.kind);
            }}
          >
            <option value="" disabled>
              {workloadsLoading && !workloadOptions.length ? 'Loading workloads…' : 'Select workload'}
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
            All Deployments, StatefulSets, CronJobs, and ScaledJobs in the namespace will be scheduled. Uncheck any to exclude. DaemonSets are always skipped.
          </p>
          {!namespace ? (
            <p className="text-xs text-muted-foreground">Select a namespace first.</p>
          ) : scalableWorkloads.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {namespaceLiveUnavailable
                ? 'Could not load workloads — the cluster API is unreachable from the server (check VPN/network and credentials).'
                : 'No scalable workloads found in this namespace.'}
            </p>
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

        </>
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

      {recurrence !== 'onetime' ? (
        <>
          {recurrence === 'split' ? (
            <>
              <div className="space-y-3 rounded-xl border border-border p-3">
                <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Weekday window
                </Label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Shutdown</Label>
                    <Input type="time" value={shutdownTime} onChange={(e) => setShutdownTime(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Startup</Label>
                    <Input type="time" value={startupTime} onChange={(e) => setStartupTime(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] text-muted-foreground">Days</Label>
                  <div className="flex flex-wrap gap-3">
                    {DAY_LABELS.map((label, i) => {
                      const day = i + 1;
                      return (
                        <label key={day} className="flex items-center gap-1.5 text-xs text-foreground/80">
                          <Checkbox
                            checked={weekdayDays.includes(day)}
                            onCheckedChange={() => toggleWeekdayDay(day)}
                          />
                          {label}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className="space-y-3 rounded-xl border border-border p-3">
                <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Weekend window
                </Label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Shutdown</Label>
                    <Input
                      type="time"
                      value={weekendShutdownTime}
                      onChange={(e) => setWeekendShutdownTime(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Startup</Label>
                    <Input
                      type="time"
                      value={weekendStartupTime}
                      onChange={(e) => setWeekendStartupTime(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] text-muted-foreground">Days</Label>
                  <div className="flex flex-wrap gap-3">
                    {DAY_LABELS.map((label, i) => {
                      const day = i + 1;
                      return (
                        <label key={day} className="flex items-center gap-1.5 text-xs text-foreground/80">
                          <Checkbox
                            checked={weekendDays.includes(day)}
                            onCheckedChange={() => toggleWeekendDay(day)}
                          />
                          {label}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
              {weekdayDays.length === 0 && weekendDays.length === 0 ? (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                  Pick at least one day in either window for this schedule to run.
                </p>
              ) : (
                <p className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-muted-foreground">
                  Each day uses the times of the window it is assigned to. A day can belong to only
                  one window.
                </p>
              )}
            </>
          ) : (
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
            </>
          )}

          {recurrence !== 'split' && (
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
          )}
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

      {platformType === 'eks' && (
        <>
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
        </>
      )}

      <div className="flex items-center justify-between rounded-xl border border-border p-3">
        <div>
          <Label>Send Teams alert</Label>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Notify Microsoft Teams on shutdown and startup for this schedule
          </p>
        </div>
        <Switch checked={teamsAlertEnabled} onCheckedChange={setTeamsAlertEnabled} />
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

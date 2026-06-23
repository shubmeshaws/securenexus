'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
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

type WorkloadTypeFilter = 'Deployment' | 'StatefulSet' | 'Job' | 'ScaledObject';

const ALL_WORKLOAD_TYPE_FILTERS: WorkloadTypeFilter[] = [
  'Deployment',
  'StatefulSet',
  'Job',
  'ScaledObject',
];

const WORKLOAD_TYPE_FILTER_LABELS: Record<WorkloadTypeFilter, string> = {
  Deployment: 'Deployments',
  StatefulSet: 'StatefulSets',
  Job: 'Jobs',
  ScaledObject: 'ScaledObjects',
};

function workloadMatchesTypeFilter(kind: string, filters: WorkloadTypeFilter[]): boolean {
  if (kind === 'Deployment') return filters.includes('Deployment');
  if (kind === 'StatefulSet') return filters.includes('StatefulSet');
  if (kind === 'CronJob' || kind === 'ScaledJob') return filters.includes('Job');
  if (kind === 'ScaledObject') return filters.includes('ScaledObject');
  return false;
}

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

interface NamespacedWorkload extends WorkloadOption {
  namespace: string;
}

type NamespaceSelectionMode = 'single' | 'multiple';

function namespacedWorkloadKey(namespace: string, kind: string, name: string): string {
  return `${namespace}::${workloadKey(kind, name)}`;
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
      shutdownDayOfWeek: 5,
      startupDayOfWeek: 1,
      windowRepeatWeekly: true,
      overnightDays: [2, 3, 4, 5] as number[],
      overnightShutdownTime: '00:00',
      overnightStartupTime: '07:00',
      syncPolicy: 'automated' as 'automated' | 'none',
      argocdInstanceId: null as string | null,
      targetReplicas: 2,
      enabled: true,
      teamsAlertEnabled: true,
      teamsManualAlertEnabled: false,
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
    shutdownDayOfWeek: schedule.shutdownDayOfWeek ?? 5,
    startupDayOfWeek: schedule.startupDayOfWeek ?? 1,
    windowRepeatWeekly: schedule.windowRepeatWeekly ?? true,
    overnightDays: schedule.overnightDays?.length
      ? schedule.overnightDays
      : recurrence === 'combined'
        ? [2, 3, 4, 5]
        : [],
    overnightShutdownTime: schedule.overnightShutdownTime ?? '00:00',
    overnightStartupTime: schedule.overnightStartupTime ?? '07:00',
    syncPolicy: schedule.syncPolicy ?? 'automated',
    argocdInstanceId: schedule.argocdInstanceId ?? null,
    targetReplicas: schedule.targetReplicas ?? 2,
    enabled: schedule.enabled ?? true,
    teamsAlertEnabled: schedule.teamsAlertEnabled ?? true,
    teamsManualAlertEnabled: schedule.teamsManualAlertEnabled ?? false,
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
  const [namespaceMode, setNamespaceMode] = useState<NamespaceSelectionMode>('single');
  const [namespace, setNamespace] = useState(initial.namespace);
  const [selectedNamespaces, setSelectedNamespaces] = useState<string[]>(
    initial.namespace ? [initial.namespace] : []
  );
  const [scope, setScope] = useState<ScheduleScope>(initial.scope);
  const [workloadTypeFilters, setWorkloadTypeFilters] = useState<WorkloadTypeFilter[]>([
    ...ALL_WORKLOAD_TYPE_FILTERS,
  ]);
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
  const [shutdownDayOfWeek, setShutdownDayOfWeek] = useState(initial.shutdownDayOfWeek);
  const [startupDayOfWeek, setStartupDayOfWeek] = useState(initial.startupDayOfWeek);
  const [windowRepeatWeekly, setWindowRepeatWeekly] = useState(initial.windowRepeatWeekly);
  const [overnightDays, setOvernightDays] = useState<number[]>(initial.overnightDays);
  const [overnightShutdownTime, setOvernightShutdownTime] = useState(initial.overnightShutdownTime);
  const [overnightStartupTime, setOvernightStartupTime] = useState(initial.overnightStartupTime);
  const [syncPolicy, setSyncPolicy] = useState<'automated' | 'none'>(initial.syncPolicy);
  const [argocdInstanceId, setArgoCDInstanceId] = useState<string | null>(initial.argocdInstanceId);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [teamsAlertEnabled, setTeamsAlertEnabled] = useState(initial.teamsAlertEnabled);
  const [teamsManualAlertEnabled, setTeamsManualAlertEnabled] = useState(
    initial.teamsManualAlertEnabled
  );

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

  const clusterOptions = useMemo(() => {
    const options = new Set((clustersData?.clusters ?? []).map((c) => c.name));
    if (cluster) options.add(cluster);
    return Array.from(options);
  }, [clustersData, cluster]);

  const namespaceOptions = useMemo(() => {
    const options = new Set(nsData?.namespaces ?? []);
    if (namespace) options.add(namespace);
    selectedNamespaces.forEach((ns) => options.add(ns));
    return Array.from(options).sort((a, b) => a.localeCompare(b));
  }, [nsData, namespace, selectedNamespaces]);

  const activeNamespaces = useMemo(() => {
    if (namespaceMode === 'single') return namespace ? [namespace] : [];
    return selectedNamespaces;
  }, [namespaceMode, namespace, selectedNamespaces]);

  const hasNamespaceSelection = activeNamespaces.length > 0;
  const isMultiNamespace = namespaceMode === 'multiple' && activeNamespaces.length > 1;

  const workloadQueries = useQueries({
    queries: activeNamespaces.map((ns) => ({
      queryKey: ['workloads', cluster, ns],
      queryFn: () =>
        apiFetch<{ workloads: WorkloadOption[] }>(
          `/api/k8s/clusters/${encodeURIComponent(cluster)}/namespaces/${encodeURIComponent(ns)}/workloads`
        ),
      enabled: platformType === 'eks' && Boolean(cluster) && Boolean(ns),
      staleTime: 60_000,
    })),
  });

  const workloadsByNamespace = useMemo(() => {
    const map = new Map<string, WorkloadOption[]>();
    activeNamespaces.forEach((ns, index) => {
      map.set(ns, workloadQueries[index]?.data?.workloads ?? []);
    });
    return map;
  }, [activeNamespaces, workloadQueries]);

  const workloadsLoading = workloadQueries.some(
    (query, index) => Boolean(activeNamespaces[index]) && query.isLoading
  );

  const allNamespacedWorkloads = useMemo(() => {
    const items: NamespacedWorkload[] = [];
    for (const ns of activeNamespaces) {
      for (const workload of workloadsByNamespace.get(ns) ?? []) {
        items.push({ ...workload, namespace: ns });
      }
    }
    return items.sort((a, b) =>
      a.namespace === b.namespace
        ? a.name.localeCompare(b.name)
        : a.namespace.localeCompare(b.namespace)
    );
  }, [activeNamespaces, workloadsByNamespace]);

  const workloadOptions = useMemo(() => {
    if (namespaceMode === 'multiple') {
      return allNamespacedWorkloads.map(({ namespace: ns, ...workload }) => workload);
    }
    const fromApi = workloadsByNamespace.get(namespace) ?? [];
    if (!appName || scope === 'namespace') return fromApi;
    const exists = fromApi.some((w) => w.name === appName && w.kind === workloadKind);
    if (exists) return fromApi;
    return [{ name: appName, kind: workloadKind }, ...fromApi];
  }, [
    namespaceMode,
    allNamespacedWorkloads,
    workloadsByNamespace,
    namespace,
    appName,
    workloadKind,
    scope,
  ]);

  const scalableWorkloads = useMemo(
    () =>
      (namespaceMode === 'multiple' ? allNamespacedWorkloads : workloadOptions).filter(
        (w) => w.kind !== 'DaemonSet'
      ),
    [namespaceMode, allNamespacedWorkloads, workloadOptions]
  );

  const filteredScalableWorkloads = useMemo(
    () => scalableWorkloads.filter((w) => workloadMatchesTypeFilter(w.kind, workloadTypeFilters)),
    [scalableWorkloads, workloadTypeFilters]
  );

  const uniqueWorkloadChoices = useMemo(() => {
    const seen = new Set<string>();
    const choices: { key: string; name: string; kind: WorkloadKind; namespaces: string[] }[] = [];
    for (const workload of allNamespacedWorkloads) {
      if (workload.kind === 'DaemonSet') continue;
      if (!workloadMatchesTypeFilter(workload.kind, workloadTypeFilters)) continue;
      const key = workloadKey(workload.kind, workload.name);
      if (seen.has(key)) {
        const existing = choices.find((choice) => choice.key === key);
        existing?.namespaces.push(workload.namespace);
        continue;
      }
      seen.add(key);
      choices.push({
        key,
        name: workload.name,
        kind: workload.kind,
        namespaces: [workload.namespace],
      });
    }
    return choices.sort((a, b) => a.name.localeCompare(b.name));
  }, [allNamespacedWorkloads, workloadTypeFilters]);

  const selectableWorkloads = useMemo(() => {
    if (scope === 'namespace') return filteredScalableWorkloads;

    if (namespaceMode === 'multiple') {
      return uniqueWorkloadChoices.map((choice) => ({
        name: choice.name,
        kind: choice.kind,
      }));
    }

    let filtered = scalableWorkloads.filter((w) =>
      workloadMatchesTypeFilter(w.kind, workloadTypeFilters)
    );
    if (appName) {
      const exists = filtered.some((w) => w.name === appName && w.kind === workloadKind);
      if (!exists) {
        filtered = [{ name: appName, kind: workloadKind }, ...filtered];
      }
    }
    return filtered;
  }, [
    scope,
    namespaceMode,
    filteredScalableWorkloads,
    uniqueWorkloadChoices,
    scalableWorkloads,
    workloadTypeFilters,
    appName,
    workloadKind,
  ]);

  useEffect(() => {
    if (scope !== 'workload' || !appName) return;
    if (!workloadMatchesTypeFilter(workloadKind, workloadTypeFilters)) {
      setAppName('');
    }
  }, [workloadTypeFilters, scope, appName, workloadKind]);

  function toggleWorkloadTypeFilter(filter: WorkloadTypeFilter) {
    setWorkloadTypeFilters((prev) => {
      if (prev.includes(filter)) {
        if (prev.length === 1) return prev;
        return prev.filter((item) => item !== filter);
      }
      return ALL_WORKLOAD_TYPE_FILTERS.filter(
        (item) => item === filter || prev.includes(item)
      );
    });
  }

  function resetWorkloadTypeFilters() {
    setWorkloadTypeFilters([...ALL_WORKLOAD_TYPE_FILTERS]);
  }

  useEffect(() => {
    if (scope !== 'workload' || !appName || namespaceMode === 'multiple') return;
    const match = (workloadsByNamespace.get(namespace) ?? []).find((w) => w.name === appName);
    if (match) setWorkloadKind(match.kind);
  }, [workloadsByNamespace, appName, scope, namespace, namespaceMode]);

  const workloadValue = appName ? workloadKey(workloadKind, appName) : '';

  function toggleSelectedNamespace(ns: string) {
    setSelectedNamespaces((prev) =>
      prev.includes(ns) ? prev.filter((item) => item !== ns) : [...prev, ns].sort()
    );
    setAppName('');
    setWorkloadKind('Deployment');
    setExcludedWorkloads([]);
    resetWorkloadTypeFilters();
  }

  function excludedStorageKey(ns: string, kind: string, name: string): string {
    return namespaceMode === 'multiple'
      ? namespacedWorkloadKey(ns, kind, name)
      : workloadKey(kind, name);
  }

  function toggleExcludedForWorkload(ns: string, kind: string, name: string) {
    const key = excludedStorageKey(ns, kind, name);
    setExcludedWorkloads((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key].sort()
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
        teamsManualAlertEnabled,
        recurrence,
      };

      const body =
        recurrence === 'onetime'
          ? {
              ...shared,
              oneTimeShutdownAt,
              oneTimeStartupAt,
            }
          : recurrence === 'combined'
            ? {
                ...shared,
                shutdownTime,
                startupTime,
                shutdownDayOfWeek,
                startupDayOfWeek,
                overnightDays,
                overnightShutdownTime,
                overnightStartupTime,
                windowRepeatWeekly: true,
              }
            : recurrence === 'window'
            ? {
                ...shared,
                shutdownTime,
                startupTime,
                shutdownDayOfWeek,
                startupDayOfWeek,
                windowRepeatWeekly,
                ...(windowRepeatWeekly
                  ? {}
                  : { oneTimeShutdownAt, oneTimeStartupAt }),
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

      if (!isNonEks && !isEdit && namespaceMode === 'multiple') {
        if (selectedNamespaces.length === 0) {
          throw new Error('Select at least one namespace');
        }

        let created = 0;
        for (const ns of selectedNamespaces) {
          if (scope === 'workload') {
            const exists = (workloadsByNamespace.get(ns) ?? []).some(
              (workload) => workload.name === appName && workload.kind === workloadKind
            );
            if (!exists) continue;
          }

          const nsExcluded =
            scope === 'namespace'
              ? excludedWorkloads
                  .filter((key) => key.startsWith(`${ns}::`))
                  .map((key) => key.slice(ns.length + 2))
              : [];

          await apiFetch('/api/schedules', {
            method: 'POST',
            body: JSON.stringify({
              ...body,
              namespace: ns,
              name: selectedNamespaces.length === 1 ? name : `${name} · ${ns}`,
              appName: scope === 'namespace' ? NAMESPACE_SCOPE_MARKER : appName,
              workloadKind: scope === 'namespace' ? 'Namespace' : workloadKind,
              excludedWorkloads: nsExcluded,
            }),
          });
          created += 1;
        }

        if (created === 0) {
          throw new Error(
            scope === 'workload'
              ? 'Selected workload was not found in any of the chosen namespaces'
              : 'No schedules were created'
          );
        }

        return { created };
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

  function toggleOvernightDay(day: number) {
    setOvernightDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)
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
                mode: 'window',
                title: 'Stop day → Start day',
                desc: 'Stop on one day (e.g. Fri) and start on another (e.g. Mon). Optional weekly repeat.',
              },
              {
                mode: 'combined',
                title: 'Long stop + nightly',
                desc: 'Cross-day stop (e.g. Fri→Mon) plus overnight stops on selected days. Repeats weekly.',
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
            setSelectedNamespaces([]);
            setNamespaceMode('single');
            setAppName('');
            setWorkloadKind('Deployment');
            setExcludedWorkloads([]);
            resetWorkloadTypeFilters();
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
        {!isEdit ? (
          <>
            <Label>Namespace selection</Label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { mode: 'single' as const, title: 'Single namespace', desc: 'One namespace per schedule' },
                  { mode: 'multiple' as const, title: 'Multiple namespaces', desc: 'Create one schedule per namespace' },
                ] as const
              ).map(({ mode, title, desc }) => (
                <button
                  key={mode}
                  type="button"
                  disabled={!cluster}
                  onClick={() => {
                    setNamespaceMode(mode);
                    if (mode === 'single') {
                      setSelectedNamespaces([]);
                    } else {
                      setNamespace('');
                    }
                    setAppName('');
                    setWorkloadKind('Deployment');
                    setExcludedWorkloads([]);
                    resetWorkloadTypeFilters();
                  }}
                  className={cn(
                    'rounded-xl border px-3 py-2.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    namespaceMode === mode
                      ? 'border-blue-500/40 bg-blue-500/10 text-foreground'
                      : 'border-border bg-background text-muted-foreground hover:border-border/80'
                  )}
                >
                  <span className="block font-medium">{title}</span>
                  <span className="mt-0.5 block text-[10px] opacity-80">{desc}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <Label>Namespace</Label>
        )}

        {namespaceMode === 'single' || isEdit ? (
          <select
            className={NATIVE_SELECT_CLASS}
            value={namespace}
            disabled={!cluster || (nsLoading && !namespaceOptions.length)}
            onChange={(e) => {
              setNamespace(e.target.value);
              setAppName('');
              setWorkloadKind('Deployment');
              setExcludedWorkloads([]);
              resetWorkloadTypeFilters();
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
        ) : (
          <div className="max-h-40 space-y-2 overflow-y-auto rounded-xl border border-border p-3 scrollbar-thin">
            {!cluster ? (
              <p className="text-xs text-muted-foreground">Select a cluster first.</p>
            ) : nsLoading && !namespaceOptions.length ? (
              <p className="text-xs text-muted-foreground">Loading namespaces…</p>
            ) : namespaceOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">No namespaces found.</p>
            ) : (
              namespaceOptions.map((ns) => (
                <label key={ns} className="flex items-center gap-2 text-xs text-foreground/90">
                  <Checkbox
                    checked={selectedNamespaces.includes(ns)}
                    onCheckedChange={() => toggleSelectedNamespace(ns)}
                  />
                  <span className="font-mono">{ns}</span>
                </label>
              ))
            )}
          </div>
        )}

        {namespaceMode === 'multiple' && selectedNamespaces.length > 0 ? (
          <p className="text-[10px] text-muted-foreground">
            {selectedNamespaces.length} namespace(s) selected — one schedule will be created for each.
          </p>
        ) : null}
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
          disabled={!hasNamespaceSelection}
          onChange={(e) => {
            const next = e.target.value as ScheduleScope;
            setScope(next);
            resetWorkloadTypeFilters();
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

      {hasNamespaceSelection ? (
        <div className="space-y-2">
          <Label>Workload type</Label>
          <div className="flex flex-wrap gap-2">
            {ALL_WORKLOAD_TYPE_FILTERS.map((filter) => {
              const active = workloadTypeFilters.includes(filter);
              return (
                <button
                  key={filter}
                  type="button"
                  onClick={() => toggleWorkloadTypeFilter(filter)}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-xs transition-colors',
                    active
                      ? 'border-blue-500/40 bg-blue-500/10 font-medium text-foreground'
                      : 'border-border bg-background text-muted-foreground hover:border-border/80'
                  )}
                >
                  {WORKLOAD_TYPE_FILTER_LABELS[filter]}
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Filter the list below. Jobs includes CronJobs and ScaledJobs. ScaledObjects are KEDA autoscaling targets.
          </p>
        </div>
      ) : null}

      {scope === 'workload' ? (
        <div className="space-y-2">
          <Label>Workload</Label>
          <select
            className={NATIVE_SELECT_CLASS}
            value={workloadValue}
            disabled={!hasNamespaceSelection || (workloadsLoading && !selectableWorkloads.length)}
            onChange={(e) => {
              const parsed = parseWorkloadKey(e.target.value);
              if (!parsed) return;
              setAppName(parsed.name);
              setWorkloadKind(parsed.kind);
            }}
          >
            <option value="" disabled>
              {workloadsLoading && !selectableWorkloads.length
                ? 'Loading workloads…'
                : selectableWorkloads.length
                  ? 'Select workload'
                  : 'No workloads match the selected filters'}
            </option>
            {selectableWorkloads.map((w) => {
              const choice = uniqueWorkloadChoices.find(
                (item) => item.name === w.name && item.kind === w.kind
              );
              const namespaceHint =
                namespaceMode === 'multiple' && choice
                  ? ` · ${choice.namespaces.length} namespace(s)`
                  : '';
              return (
                <option key={workloadKey(w.kind, w.name)} value={workloadKey(w.kind, w.name)}>
                  {w.name} ({w.kind}){namespaceHint}
                </option>
              );
            })}
          </select>
          {namespaceMode === 'multiple' && appName ? (
            <p className="text-[10px] text-muted-foreground">
              Creates one schedule per selected namespace where this workload exists.
            </p>
          ) : null}
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
            All Deployments, StatefulSets, CronJobs, ScaledJobs, and ScaledObjects in{' '}
            {isMultiNamespace ? 'each selected namespace' : 'the namespace'} will be scheduled.
            Uncheck any to exclude. DaemonSets are always skipped.
          </p>
          {!hasNamespaceSelection ? (
            <p className="text-xs text-muted-foreground">Select a namespace first.</p>
          ) : filteredScalableWorkloads.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {namespaceLiveUnavailable
                ? 'Could not load workloads — the cluster API is unreachable from the server (check VPN/network and credentials).'
                : scalableWorkloads.length === 0
                  ? 'No scalable workloads found in the selected namespace(s).'
                  : 'No workloads match the selected filters.'}
            </p>
          ) : namespaceMode === 'multiple' ? (
            <div className="max-h-52 space-y-3 overflow-y-auto rounded-xl border border-border p-3 scrollbar-thin">
              {activeNamespaces.map((ns) => {
                const workloads = filteredScalableWorkloads.filter(
                  (workload): workload is NamespacedWorkload =>
                    'namespace' in workload && workload.namespace === ns
                );
                if (!workloads.length) {
                  return (
                    <div key={ns} className="space-y-1">
                      <p className="font-mono text-[10px] font-medium text-muted-foreground">{ns}</p>
                      <p className="text-[10px] text-muted-foreground">No matching workloads.</p>
                    </div>
                  );
                }
                return (
                  <div key={ns} className="space-y-2">
                    <p className="font-mono text-[10px] font-medium text-muted-foreground">{ns}</p>
                    {workloads.map((workload) => {
                      const key = excludedStorageKey(ns, workload.kind, workload.name);
                      const excluded = excludedWorkloads.includes(key);
                      return (
                        <label
                          key={key}
                          className="flex items-center gap-2 text-xs text-foreground/90"
                        >
                          <Checkbox
                            checked={!excluded}
                            onCheckedChange={() =>
                              toggleExcludedForWorkload(ns, workload.kind, workload.name)
                            }
                          />
                          <span className="font-mono">{workload.name}</span>
                          <Badge variant="secondary" className="font-mono text-[9px]">
                            {workload.kind}
                          </Badge>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="max-h-40 space-y-2 overflow-y-auto rounded-xl border border-border p-3 scrollbar-thin">
              {filteredScalableWorkloads.map((w) => {
                const key = excludedStorageKey(namespace, w.kind, w.name);
                const excluded = excludedWorkloads.includes(key);
                return (
                  <label
                    key={key}
                    className="flex items-center gap-2 text-xs text-foreground/90"
                  >
                    <Checkbox
                      checked={!excluded}
                      onCheckedChange={() => toggleExcludedForWorkload(namespace, w.kind, w.name)}
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
            if (recurrence === 'onetime' || (recurrence === 'window' && !windowRepeatWeekly)) {
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

      {recurrence === 'onetime' ? (
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
      ) : recurrence === 'combined' ? (
        <>
          <div className="space-y-3 rounded-xl border border-border p-3">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Long stop window
            </Label>
            <p className="text-[10px] text-muted-foreground">
              Resources stay down from stop day/time until start day/time (e.g. Fri 11:30 PM → Mon 7 AM).
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Stop day</Label>
                <select
                  className={NATIVE_SELECT_CLASS}
                  value={shutdownDayOfWeek}
                  onChange={(e) => setShutdownDayOfWeek(Number(e.target.value))}
                >
                  {DAY_LABELS.map((label, i) => (
                    <option key={label} value={i + 1}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Stop time</Label>
                <Input type="time" value={shutdownTime} onChange={(e) => setShutdownTime(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Start day</Label>
                <select
                  className={NATIVE_SELECT_CLASS}
                  value={startupDayOfWeek}
                  onChange={(e) => setStartupDayOfWeek(Number(e.target.value))}
                >
                  {DAY_LABELS.map((label, i) => (
                    <option key={label} value={i + 1}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Start time</Label>
                <Input type="time" value={startupTime} onChange={(e) => setStartupTime(e.target.value)} />
              </div>
            </div>
          </div>
          <div className="space-y-3 rounded-xl border border-border p-3">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Nightly stops
            </Label>
            <p className="text-[10px] text-muted-foreground">
              On selected days, stop at the first time and start at the second (same day). Pick any days — not
              limited to weekday/weekend groups.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Stop time</Label>
                <Input
                  type="time"
                  value={overnightShutdownTime}
                  onChange={(e) => setOvernightShutdownTime(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Start time</Label>
                <Input
                  type="time"
                  value={overnightStartupTime}
                  onChange={(e) => setOvernightStartupTime(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Days with nightly stop</Label>
              <div className="flex flex-wrap gap-3">
                {DAY_LABELS.map((label, i) => {
                  const day = i + 1;
                  return (
                    <label key={day} className="flex items-center gap-1.5 text-xs text-foreground/80">
                      <Checkbox
                        checked={overnightDays.includes(day)}
                        onCheckedChange={() => toggleOvernightDay(day)}
                      />
                      {label}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
          <p className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-muted-foreground">
            Example: long stop {DAY_LABELS[shutdownDayOfWeek - 1]} {formatTime12h(shutdownTime)} →{' '}
            {DAY_LABELS[startupDayOfWeek - 1]} {formatTime12h(startupTime)}, plus nightly{' '}
            {formatTime12h(overnightShutdownTime)}–{formatTime12h(overnightStartupTime)} on{' '}
            {overnightDays.length
              ? overnightDays.map((d) => DAY_LABELS[d - 1]).join(', ')
              : 'no days selected'}
            . Repeats every week; today&apos;s timeline is evaluated from the current day and time.
          </p>
        </>
      ) : recurrence === 'window' ? (
        <>
          <div className="flex items-center justify-between rounded-xl border border-border p-3">
            <div>
              <Label>Repeat every week</Label>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Turn off to run this stop → start window only once
              </p>
            </div>
            <Switch checked={windowRepeatWeekly} onCheckedChange={setWindowRepeatWeekly} />
          </div>

          {windowRepeatWeekly ? (
            <>
              <div className="space-y-3 rounded-xl border border-border p-3">
                <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Stop
                </Label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Day</Label>
                    <select
                      className={NATIVE_SELECT_CLASS}
                      value={shutdownDayOfWeek}
                      onChange={(e) => setShutdownDayOfWeek(Number(e.target.value))}
                    >
                      {DAY_LABELS.map((label, i) => (
                        <option key={label} value={i + 1}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Time</Label>
                    <Input
                      type="time"
                      value={shutdownTime}
                      onChange={(e) => setShutdownTime(e.target.value)}
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-3 rounded-xl border border-border p-3">
                <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Start
                </Label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Day</Label>
                    <select
                      className={NATIVE_SELECT_CLASS}
                      value={startupDayOfWeek}
                      onChange={(e) => setStartupDayOfWeek(Number(e.target.value))}
                    >
                      {DAY_LABELS.map((label, i) => (
                        <option key={label} value={i + 1}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Time</Label>
                    <Input
                      type="time"
                      value={startupTime}
                      onChange={(e) => setStartupTime(e.target.value)}
                    />
                  </div>
                </div>
              </div>
              <p className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-muted-foreground">
                Example: stop {DAY_LABELS[shutdownDayOfWeek - 1]} at {formatTime12h(shutdownTime)},{' '}
                start {DAY_LABELS[startupDayOfWeek - 1]} at {formatTime12h(startupTime)} — repeats every
                week. Workloads stay down between stop and start.
              </p>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Stop date & time</Label>
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
                <Label>Start date & time</Label>
                <Input
                  type="datetime-local"
                  value={oneTimeStartupAt}
                  min={oneTimeShutdownAt}
                  onChange={(e) => setOneTimeStartupAt(e.target.value)}
                  required
                />
              </div>
              <p className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-muted-foreground">
                Runs this cross-day window once, then disables after startup completes.
              </p>
            </>
          )}
        </>
      ) : recurrence === 'split' ? (
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
          <Label>Automatic schedule alert</Label>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Notify Microsoft Teams when this schedule runs on its automatic shutdown/startup times
          </p>
        </div>
        <Switch checked={teamsAlertEnabled} onCheckedChange={setTeamsAlertEnabled} />
      </div>

      <div className="flex items-center justify-between rounded-xl border border-border p-3">
        <div>
          <Label>Manual schedule alert</Label>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Notify Microsoft Teams when someone manually stops or starts this schedule from the UI
          </p>
        </div>
        <Switch
          checked={teamsManualAlertEnabled}
          onCheckedChange={setTeamsManualAlertEnabled}
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
          {mutation.isPending
            ? 'Saving...'
            : isEdit
              ? 'Update'
              : namespaceMode === 'multiple' && selectedNamespaces.length > 1
                ? `Create ${selectedNamespaces.length} schedules`
                : 'Create'}
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

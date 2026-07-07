'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  CloudUpload,
  Loader2,
  MessageSquare,
  PlusCircle,
  Webhook,
} from '@/lib/icons';
import { apiFetch } from '@/lib/api-client';
import { GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ScanMultiSelect } from '@/components/pod-scheduler/scan-multi-select';
import { SecurityAutomationSavedList } from '@/components/pod-scheduler/security-automation-saved-list';
import { cn } from '@/lib/utils';
import type { SecurityAutomationView } from '@/lib/security-automation-service';
import type { SecurityResourceView, SecurityToolSettingView } from '@/lib/security-service';
import type { SecurityReportMode } from '@/lib/security-scan-types';
import {
  AUTOMATION_SCHEDULE_FREQUENCIES,
  formatAutomationScheduleSummary,
  validateAutomationSchedule,
  type AutomationScheduleFrequency,
} from '@/lib/security-automation-schedule';
import type { AwsCredentialView } from '@/lib/aws-credential-store';
import {
  SECURITY_TOOL_CATEGORIES,
  SECURITY_TOOLS,
  compatibleToolsForResources,
  resolveScanPairs,
  type SecurityToolCategory,
} from '@/lib/security-tools';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const WEEKDAYS: { value: number; label: string; short: string }[] = [
  { value: 0, label: 'Sunday', short: 'Sun' },
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
];

const TIMEZONE_OPTIONS = ['UTC', 'Asia/Kolkata', 'America/New_York', 'Europe/London', 'Asia/Singapore'];

const MONTH_OPTIONS = [
  { value: 1, label: 'January' },
  { value: 2, label: 'February' },
  { value: 3, label: 'March' },
  { value: 4, label: 'April' },
  { value: 5, label: 'May' },
  { value: 6, label: 'June' },
  { value: 7, label: 'July' },
  { value: 8, label: 'August' },
  { value: 9, label: 'September' },
  { value: 10, label: 'October' },
  { value: 11, label: 'November' },
  { value: 12, label: 'December' },
];

type AutomationDraft = {
  name: string;
  enabled: boolean;
  scheduleFrequency: AutomationScheduleFrequency;
  scheduleTime: string;
  scheduleDays: number[];
  scheduleDayOfMonth: number | null;
  scheduleMonth: number | null;
  scheduleStartDate: string;
  timezone: string;
  resourceIds: string[];
  scanCategories: SecurityToolCategory[];
  toolIds: string[];
  reportMode: SecurityReportMode;
  s3Enabled: boolean;
  s3Bucket: string;
  s3Region: string;
  s3Prefix: string;
  awsCredentialId: string;
  teamsEnabled: boolean;
  teamsWebhookUrl: string;
};

function emptyDraft(): AutomationDraft {
  return {
    name: '',
    enabled: true,
    scheduleFrequency: 'weekly',
    scheduleTime: '02:00',
    scheduleDays: [1, 2, 3, 4, 5],
    scheduleDayOfMonth: 1,
    scheduleMonth: 1,
    scheduleStartDate: '',
    timezone: 'UTC',
    resourceIds: [],
    scanCategories: [],
    toolIds: [],
    reportMode: 'separate',
    s3Enabled: false,
    s3Bucket: '',
    s3Region: '',
    s3Prefix: 'security-reports/',
    awsCredentialId: '',
    teamsEnabled: false,
    teamsWebhookUrl: '',
  };
}

function draftFromAutomation(row: SecurityAutomationView): AutomationDraft {
  return {
    name: row.name,
    enabled: row.enabled,
    scheduleFrequency: row.scheduleFrequency,
    scheduleTime: row.scheduleTime,
    scheduleDays: row.scheduleDays,
    scheduleDayOfMonth: row.scheduleDayOfMonth,
    scheduleMonth: row.scheduleMonth,
    scheduleStartDate: row.scheduleStartDate ?? '',
    timezone: row.timezone,
    resourceIds: row.resourceIds,
    scanCategories: row.scanCategories,
    toolIds: row.toolIds,
    reportMode: row.reportMode,
    s3Enabled: row.s3Enabled,
    s3Bucket: row.s3Bucket ?? '',
    s3Region: row.s3Region ?? '',
    s3Prefix: row.s3Prefix ?? '',
    awsCredentialId: row.awsCredentialId ?? '',
    teamsEnabled: row.teamsEnabled,
    teamsWebhookUrl: row.teamsWebhookUrl ?? '',
  };
}

function TeamsNotificationPreview({
  title,
  scanTypes,
  repositories,
  urls,
  status,
  reportLinks,
  scheduleSummary,
  s3Bucket,
}: {
  title: string;
  scanTypes: string[];
  repositories: string[];
  urls: string[];
  status: 'Success' | 'Failed';
  reportLinks: Array<{ title: string; htmlUrl: string }>;
  scheduleSummary: string;
  s3Bucket?: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-violet-200/60 bg-gradient-to-b from-violet-50/80 to-white shadow-sm dark:border-violet-500/20 dark:from-violet-950/30 dark:to-card">
      <div className="border-b border-violet-200/60 bg-gradient-to-r from-violet-600/10 via-sky-500/10 to-emerald-500/10 px-4 py-3 dark:border-violet-500/20">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-violet-700 dark:text-violet-300">
              🛡️ Security Scan Report
            </p>
            <p className="text-xs font-medium text-foreground">{title}</p>
          </div>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-semibold',
              status === 'Success'
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
                : 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300'
            )}
          >
            {status}
          </span>
        </div>
      </div>
      <div className="space-y-0 bg-white/80 dark:bg-background/80">
        <PreviewRow label="Scan coverage" value={scanTypes.length ? scanTypes.join(' · ') : 'SAST · SCA'} accent />
        {repositories.length ? (
          <PreviewRow label="Repositories" value={repositories.join('\n')} mono />
        ) : null}
        {urls.length ? <PreviewRow label="URL" value={urls.join('\n')} mono /> : null}
        {status === 'Success' ? (
          <div className="grid grid-cols-[140px_1fr] gap-3 border-t border-violet-100 px-4 py-2.5 text-xs dark:border-border">
            <span className="font-medium text-violet-600 dark:text-violet-300">Findings</span>
            <div className="flex flex-wrap gap-2">
              <FindingPill label="High" value={3} tone="red" />
              <FindingPill label="Medium" value={6} tone="amber" />
              <FindingPill label="Low" value={1} tone="slate" />
            </div>
          </div>
        ) : (
          <PreviewRow label="Status" value="Scan did not complete" accent="text-red-600" />
        )}
        <PreviewRow label="Scheduled" value={scheduleSummary} />
        {reportLinks.length ? (
          <div className="grid grid-cols-[140px_1fr] gap-3 border-t border-violet-100 px-4 py-2.5 text-xs dark:border-border">
            <span className="font-medium text-emerald-700 dark:text-emerald-300">Report URLs (S3)</span>
            <div className="space-y-1">
              {s3Bucket ? (
                <p className="text-[10px] text-muted-foreground">Bucket: {s3Bucket}</p>
              ) : null}
              {reportLinks.map((link) => (
                <a
                  key={link.htmlUrl}
                  href={link.htmlUrl}
                  className="block break-all text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300"
                  onClick={(event) => event.preventDefault()}
                >
                  {link.title} · HTML
                </a>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="border-t border-violet-100 bg-violet-50/50 px-4 py-2 text-[10px] text-muted-foreground dark:border-border dark:bg-muted/20">
        Preview — actual Adaptive Card is sent to Microsoft Teams when a scheduled scan completes.
      </div>
    </div>
  );
}

function PreviewRow({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean | string;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 border-t border-violet-100 px-4 py-2.5 text-xs dark:border-border">
      <span
        className={cn(
          'font-medium',
          accent === true
            ? 'text-violet-600 dark:text-violet-300'
            : 'text-muted-foreground'
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          'whitespace-pre-wrap break-all text-foreground',
          mono && 'font-mono text-[11px]',
          typeof accent === 'string' && accent
        )}
      >
        {value}
      </span>
    </div>
  );
}

function FindingPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'red' | 'amber' | 'slate';
}) {
  const styles = {
    red: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300',
    amber: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
    slate: 'bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300',
  }[tone];

  return (
    <span className={cn('rounded-md px-2 py-1 text-[11px] font-semibold', styles)}>
      {value} {label}
    </span>
  );
}

export function SecurityAutomationPanel({
  resources,
  toolSettings,
  loading,
}: {
  resources: SecurityResourceView[];
  toolSettings: SecurityToolSettingView[];
  loading: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AutomationDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<'Success' | 'Failed'>('Success');
  const [s3BucketStatus, setS3BucketStatus] = useState<{
    status: 'created' | 'already_exists';
    message: string;
  } | null>(null);
  const [teamsTestStatus, setTeamsTestStatus] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['security-automation'],
    queryFn: () => apiFetch<{ automations: SecurityAutomationView[] }>('/api/security/automation'),
    refetchInterval: (query) => {
      const rows = query.state.data?.automations ?? [];
      return rows.some((row) => row.runStatus === 'running') ? 3000 : false;
    },
  });

  const { data: awsCredsData } = useQuery({
    queryKey: ['aws-credentials-picker'],
    queryFn: () => apiFetch<{ credentials: AwsCredentialView[] }>('/api/aws-credentials'),
  });

  const automations = data?.automations ?? [];
  const awsCredentials = awsCredsData?.credentials ?? [];

  const enabledResources = useMemo(
    () => resources.filter((row) => row.enabled),
    [resources]
  );

  const resourceOptions = useMemo(
    () => enabledResources.map((row) => row.id),
    [enabledResources]
  );

  const resourceById = useMemo(
    () => new Map(enabledResources.map((row) => [row.id, row])),
    [enabledResources]
  );

  const enabledToolIds = useMemo(
    () => new Set(toolSettings.filter((row) => row.enabled).map((row) => row.toolId)),
    [toolSettings]
  );

  const selectedResources = useMemo(
    () => enabledResources.filter((row) => draft.resourceIds.includes(row.id)),
    [enabledResources, draft.resourceIds]
  );

  const availableTools = useMemo(() => {
    if (!selectedResources.length || !draft.scanCategories.length) return [];
    return compatibleToolsForResources(
      selectedResources,
      enabledToolIds,
      draft.scanCategories
    );
  }, [selectedResources, draft.scanCategories, enabledToolIds]);

  const scanPairCount = useMemo(() => {
    if (!selectedResources.length || !draft.toolIds.length) return 0;
    return resolveScanPairs({
      resources: selectedResources.map((row) => ({
        id: row.id,
        type: row.type,
      })),
      toolIds: draft.toolIds,
      enabledToolIds,
    }).length;
  }, [selectedResources, draft.toolIds, enabledToolIds]);

  const previewScanTypes = useMemo(
    () =>
      draft.scanCategories.map(
        (id) => SECURITY_TOOL_CATEGORIES.find((row) => row.id === id)?.label ?? id.toUpperCase()
      ),
    [draft.scanCategories]
  );

  const previewRepositories = useMemo(
    () =>
      selectedResources
        .filter((row) => row.type === 'repository' || (row.repoUrl && row.type !== 'target_url'))
        .map((row) => row.repoUrl ?? row.name)
        .filter((url): url is string => Boolean(url)),
    [selectedResources]
  );

  const previewUrls = useMemo(
    () =>
      selectedResources
        .filter((row) => row.type === 'target_url' || (!row.repoUrl && row.targetUrl))
        .map((row) => row.targetUrl ?? row.name)
        .filter((url): url is string => Boolean(url)),
    [selectedResources]
  );

  const previewReportLinks = useMemo(() => {
    const bucket = draft.s3Bucket.trim() || 'my-security-reports';
    const region = draft.s3Region.trim() || 'us-east-1';
    const folder = `security-reports/${draft.name || 'automation'}/2026-07-07-16-52`;
    const reports =
      draft.toolIds.length > 0
        ? draft.toolIds.map((toolId) => SECURITY_TOOLS.find((t) => t.id === toolId)?.name ?? toolId)
        : ['SAST Report'];
    return reports.map((title) => ({
      title,
      htmlUrl: `https://${bucket}.s3.${region}.amazonaws.com/${folder}/${title.toLowerCase().replace(/\s+/g, '-')}.html`,
    }));
  }, [draft.s3Bucket, draft.s3Region, draft.name, draft.toolIds]);

  const draftScheduleSummary = useMemo(
    () =>
      formatAutomationScheduleSummary({
        scheduleFrequency: draft.scheduleFrequency,
        scheduleTime: draft.scheduleTime,
        scheduleDays: draft.scheduleDays,
        scheduleDayOfMonth: draft.scheduleDayOfMonth,
        scheduleMonth: draft.scheduleMonth,
        scheduleStartDate: draft.scheduleStartDate || null,
        timezone: draft.timezone,
      }),
    [draft]
  );

  const scheduleError = useMemo(
    () =>
      validateAutomationSchedule({
        scheduleFrequency: draft.scheduleFrequency,
        scheduleTime: draft.scheduleTime,
        scheduleDays: draft.scheduleDays,
        scheduleDayOfMonth: draft.scheduleDayOfMonth,
        scheduleMonth: draft.scheduleMonth,
        scheduleStartDate: draft.scheduleStartDate || null,
        timezone: draft.timezone,
      }),
    [draft]
  );

  const saveAutomation = useMutation({
    mutationFn: async () => {
      const body = {
        name: draft.name.trim(),
        enabled: draft.enabled,
        scheduleFrequency: draft.scheduleFrequency,
        scheduleTime: draft.scheduleTime,
        scheduleDays: draft.scheduleDays,
        scheduleDayOfMonth: draft.scheduleDayOfMonth,
        scheduleMonth: draft.scheduleMonth,
        scheduleStartDate: draft.scheduleStartDate || null,
        timezone: draft.timezone,
        resourceIds: draft.resourceIds,
        scanCategories: draft.scanCategories,
        toolIds: draft.toolIds,
        reportMode: scanPairCount > 1 ? draft.reportMode : 'separate',
        s3Enabled: draft.s3Enabled,
        s3Bucket: draft.s3Bucket || undefined,
        s3Region: draft.s3Region || undefined,
        s3Prefix: draft.s3Prefix || undefined,
        awsCredentialId: draft.awsCredentialId || null,
        teamsEnabled: draft.teamsEnabled,
        teamsWebhookUrl: draft.teamsWebhookUrl || undefined,
      };

      if (editingId) {
        return apiFetch<{ automation: SecurityAutomationView }>(
          `/api/security/automation/${editingId}`,
          { method: 'PUT', body: JSON.stringify(body) }
        );
      }

      return apiFetch<{ automation: SecurityAutomationView }>('/api/security/automation', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security-automation'] });
      setDraft(emptyDraft());
      setEditingId(null);
      setS3BucketStatus(null);
    },
  });

  const createS3Bucket = useMutation({
    mutationFn: () =>
      apiFetch<{
        status: 'created' | 'already_exists';
        bucket: string;
        region: string;
        message: string;
      }>('/api/security/automation/s3-bucket', {
        method: 'POST',
        body: JSON.stringify({
          awsCredentialId: draft.awsCredentialId,
          bucket: draft.s3Bucket,
          region: draft.s3Region || undefined,
        }),
      }),
    onSuccess: (result) => {
      setS3BucketStatus({ status: result.status, message: result.message });
      setDraft((prev) => ({
        ...prev,
        s3Bucket: result.bucket,
        s3Region: result.region,
      }));
    },
  });

  const deleteAutomation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/security/automation/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security-automation'] });
      if (editingId) {
        setEditingId(null);
        setDraft(emptyDraft());
      }
    },
  });

  const toggleAutomation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch<{ automation: SecurityAutomationView }>(`/api/security/automation/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['security-automation'] }),
  });

  const testTeamsNotification = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; message: string }>('/api/security/automation/test-teams', {
        method: 'POST',
        body: JSON.stringify({
          name: draft.name || 'Security Scan Test',
          teamsWebhookUrl: draft.teamsWebhookUrl || undefined,
          scanCategories: draft.scanCategories,
          resourceIds: draft.resourceIds,
          s3Bucket: draft.s3Bucket || undefined,
          s3Region: draft.s3Region || undefined,
        }),
      }),
    onSuccess: (result) => setTeamsTestStatus(result),
    onError: (err: Error) =>
      setTeamsTestStatus({ ok: false, message: err.message || 'Teams test failed' }),
  });

  function toggleDay(day: number) {
    setDraft((prev) => ({
      ...prev,
      scheduleDays: prev.scheduleDays.includes(day)
        ? prev.scheduleDays.filter((d) => d !== day)
        : [...prev.scheduleDays, day].sort((a, b) => a - b),
    }));
  }

  function toggleCategory(category: SecurityToolCategory) {
    setDraft((prev) => {
      const nextCategories = prev.scanCategories.includes(category)
        ? prev.scanCategories.filter((id) => id !== category)
        : [...prev.scanCategories, category];
      const allowedTools = new Set(
        compatibleToolsForResources(
          enabledResources.filter((row) => prev.resourceIds.includes(row.id)),
          enabledToolIds,
          nextCategories
        ).map((tool) => tool.id)
      );
      return {
        ...prev,
        scanCategories: nextCategories,
        toolIds: prev.toolIds.filter((id) => allowedTools.has(id)),
      };
    });
  }

  function handleResourceChange(resourceIds: string[]) {
    setDraft((prev) => {
      const selected = enabledResources.filter((row) => resourceIds.includes(row.id));
      const allowedTools = new Set(
        compatibleToolsForResources(selected, enabledToolIds, prev.scanCategories).map(
          (tool) => tool.id
        )
      );
      return {
        ...prev,
        resourceIds,
        toolIds: prev.toolIds.filter((tid) => allowedTools.has(tid)),
      };
    });
  }

  function toggleTool(id: string) {
    setDraft((prev) => ({
      ...prev,
      toolIds: prev.toolIds.includes(id)
        ? prev.toolIds.filter((tid) => tid !== id)
        : [...prev.toolIds, id],
    }));
  }

  const canSave =
    draft.name.trim() &&
    !scheduleError &&
    draft.resourceIds.length > 0 &&
    draft.scanCategories.length > 0 &&
    draft.toolIds.length > 0 &&
    (!draft.s3Enabled || (draft.s3Bucket.trim() && draft.awsCredentialId));

  const showWeekdays = draft.scheduleFrequency === 'weekly';
  const showDayOfMonth =
    draft.scheduleFrequency === 'monthly' ||
    draft.scheduleFrequency === 'quarterly' ||
    draft.scheduleFrequency === 'semiannual' ||
    draft.scheduleFrequency === 'yearly';
  const showMonth = draft.scheduleFrequency === 'yearly';
  const showStartDate =
    draft.scheduleFrequency === 'once' ||
    draft.scheduleFrequency === 'quarterly' ||
    draft.scheduleFrequency === 'semiannual';

  if (loading || isLoading) {
    return (
      <GlassPanel className="flex flex-col">
        <PanelHeader title="Automation" icon={Bot} accent="violet" />
        <div className="flex justify-center p-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </GlassPanel>
    );
  }

  return (
    <div className="space-y-4">
      <GlassPanel className="flex flex-col overflow-visible">
        <PanelHeader
          title="Automation"
          icon={Bot}
          accent="violet"
          action={
            editingId ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-[11px]"
                onClick={() => {
                  setEditingId(null);
                  setDraft(emptyDraft());
                }}
              >
                New automation
              </Button>
            ) : null
          }
        />
        <p className="border-b border-border px-5 pb-3 text-[11px] text-muted-foreground">
          Schedule recurring security scans, upload reports to S3, and notify Microsoft Teams when
          scans complete.
        </p>

        <div className="grid gap-6 px-5 py-5 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-[11px]">Automation name</Label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="Nightly SAST + SCA"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-[11px]">Schedule frequency</Label>
                <Select
                  value={draft.scheduleFrequency}
                  onValueChange={(scheduleFrequency) =>
                    setDraft((prev) => ({
                      ...prev,
                      scheduleFrequency: scheduleFrequency as AutomationScheduleFrequency,
                    }))
                  }
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTOMATION_SCHEDULE_FREQUENCIES.map((freq) => (
                      <SelectItem key={freq.id} value={freq.id}>
                        {freq.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">
                  {
                    AUTOMATION_SCHEDULE_FREQUENCIES.find((row) => row.id === draft.scheduleFrequency)
                      ?.description
                  }
                </p>
              </div>
              {showStartDate ? (
                <div className="space-y-1.5">
                  <Label className="text-[11px]">
                    {draft.scheduleFrequency === 'once' ? 'Run date' : 'Anchor start date'}
                  </Label>
                  <Input
                    type="date"
                    value={draft.scheduleStartDate}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, scheduleStartDate: e.target.value }))
                    }
                  />
                </div>
              ) : null}
              {showMonth ? (
                <div className="space-y-1.5">
                  <Label className="text-[11px]">Month</Label>
                  <Select
                    value={String(draft.scheduleMonth ?? 1)}
                    onValueChange={(value) =>
                      setDraft((prev) => ({ ...prev, scheduleMonth: Number(value) }))
                    }
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTH_OPTIONS.map((month) => (
                        <SelectItem key={month.value} value={String(month.value)}>
                          {month.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {showDayOfMonth ? (
                <div className="space-y-1.5">
                  <Label className="text-[11px]">Day of month</Label>
                  <Select
                    value={String(draft.scheduleDayOfMonth ?? 1)}
                    onValueChange={(value) =>
                      setDraft((prev) => ({ ...prev, scheduleDayOfMonth: Number(value) }))
                    }
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                        <SelectItem key={day} value={String(day)}>
                          {day}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label className="text-[11px]">Schedule time</Label>
                <Input
                  type="time"
                  value={draft.scheduleTime}
                  onChange={(e) => setDraft((prev) => ({ ...prev, scheduleTime: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px]">Timezone</Label>
                <Select
                  value={draft.timezone}
                  onValueChange={(timezone) => setDraft((prev) => ({ ...prev, timezone }))}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONE_OPTIONS.map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {showWeekdays ? (
              <div className="space-y-2">
                <Label className="text-[11px]">Run on days</Label>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map((day) => (
                    <button
                      key={day.value}
                      type="button"
                      onClick={() => toggleDay(day.value)}
                      className={cn(
                        'rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors',
                        draft.scheduleDays.includes(day.value)
                          ? 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                          : 'border-border text-muted-foreground hover:bg-muted/50'
                      )}
                    >
                      {day.short}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <p className="rounded-lg border border-dashed border-border/80 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
              {draftScheduleSummary}
            </p>
            {scheduleError ? (
              <p className="text-[11px] text-red-600">{scheduleError}</p>
            ) : null}

            <ScanMultiSelect
              label="Repositories to scan"
              description="Select one or more repositories or targets."
              options={resourceOptions}
              selected={draft.resourceIds}
              onChange={handleResourceChange}
              getLabel={(id) => resourceById.get(id)?.name ?? id}
              getMeta={(id) => {
                const row = resourceById.get(id);
                return row?.repoUrl ?? row?.targetUrl ?? undefined;
              }}
              placeholder="Select repositories…"
              disabled={enabledResources.length === 0}
            />

            <div className="space-y-2">
              <Label className="text-[11px]">Scan types</Label>
              <div className="flex flex-wrap gap-2">
                {SECURITY_TOOL_CATEGORIES.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => toggleCategory(category.id)}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-left text-[11px] transition-colors',
                      draft.scanCategories.includes(category.id)
                        ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                        : 'border-border text-muted-foreground hover:bg-muted/50'
                    )}
                  >
                    <span className="font-medium">{category.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-[11px]">Tools</Label>
              <div className="flex flex-wrap gap-2">
                {availableTools.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Select repositories and scan types first.
                  </p>
                ) : (
                  availableTools.map((tool) => (
                    <button
                      key={tool.id}
                      type="button"
                      onClick={() => toggleTool(tool.id)}
                      className={cn(
                        'rounded-lg border px-3 py-1.5 text-[11px] transition-colors',
                        draft.toolIds.includes(tool.id)
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-border text-muted-foreground hover:bg-muted/50'
                      )}
                    >
                      {tool.name}
                    </button>
                  ))
                )}
              </div>
            </div>

            {scanPairCount > 1 ? (
              <div className="space-y-2">
                <Label className="text-[11px]">Report output</Label>
                <div className="inline-flex rounded-lg border border-border bg-card/60 p-1">
                  <button
                    type="button"
                    onClick={() => setDraft((prev) => ({ ...prev, reportMode: 'separate' }))}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors',
                      draft.reportMode === 'separate'
                        ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    Separate reports ({scanPairCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraft((prev) => ({ ...prev, reportMode: 'merged' }))}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors',
                      draft.reportMode === 'merged'
                        ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    One merged report
                  </button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {draft.reportMode === 'merged'
                    ? 'All scan results are combined into a single HTML, CSV, and PDF report.'
                    : 'Each tool and repository combination produces its own report files.'}
                </p>
              </div>
            ) : null}

            <div className="rounded-xl border border-border p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <CloudUpload className="h-4 w-4 text-sky-600" />
                  <Label className="text-xs font-medium">S3 bucket upload</Label>
                </div>
                <Switch
                  checked={draft.s3Enabled}
                  onCheckedChange={(s3Enabled) => setDraft((prev) => ({ ...prev, s3Enabled }))}
                />
              </div>
              {draft.s3Enabled ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label className="text-[10px]">AWS credentials</Label>
                    {awsCredentials.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground">
                        No AWS credentials found. Add them in Admin Panel → Settings → AWS
                        Credentials.
                      </p>
                    ) : (
                      <Select
                        value={draft.awsCredentialId || undefined}
                        onValueChange={(awsCredentialId) => {
                          const cred = awsCredentials.find((row) => row.id === awsCredentialId);
                          setS3BucketStatus(null);
                          setDraft((prev) => ({
                            ...prev,
                            awsCredentialId,
                            s3Region: prev.s3Region || cred?.defaultRegion || '',
                          }));
                        }}
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue placeholder="Select AWS credentials…" />
                        </SelectTrigger>
                        <SelectContent>
                          {awsCredentials.map((cred) => (
                            <SelectItem key={cred.id} value={cred.id}>
                              {cred.name}
                              {cred.awsAccountId ? ` · ${cred.awsAccountId}` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10px]">Bucket</Label>
                    <div className="flex gap-2">
                      <Input
                        value={draft.s3Bucket}
                        onChange={(e) => {
                          setS3BucketStatus(null);
                          setDraft((prev) => ({ ...prev, s3Bucket: e.target.value }));
                        }}
                        placeholder="my-security-reports"
                        className="min-w-0 flex-1"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-9 shrink-0 text-[11px]"
                        disabled={
                          !draft.awsCredentialId ||
                          !draft.s3Bucket.trim() ||
                          createS3Bucket.isPending
                        }
                        onClick={() => createS3Bucket.mutate()}
                      >
                        {createS3Bucket.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        Create bucket
                      </Button>
                    </div>
                    {s3BucketStatus ? (
                      <p
                        className={cn(
                          'text-[10px]',
                          s3BucketStatus.status === 'created'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-muted-foreground'
                        )}
                      >
                        {s3BucketStatus.message}
                      </p>
                    ) : null}
                    {createS3Bucket.isError ? (
                      <p className="text-[10px] text-red-600">
                        {createS3Bucket.error instanceof Error
                          ? createS3Bucket.error.message
                          : 'Failed to create bucket'}
                      </p>
                    ) : null}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10px]">Region</Label>
                    <Input
                      value={draft.s3Region}
                      onChange={(e) => setDraft((prev) => ({ ...prev, s3Region: e.target.value }))}
                      placeholder="ap-south-1"
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label className="text-[10px]">Prefix</Label>
                    <Input
                      value={draft.s3Prefix}
                      onChange={(e) => setDraft((prev) => ({ ...prev, s3Prefix: e.target.value }))}
                      placeholder="security-reports/"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      After each run, HTML, CSV, and PDF files are uploaded under this prefix.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="rounded-xl border border-border p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Webhook className="h-4 w-4 text-violet-600" />
                  <Label className="text-xs font-medium">Microsoft Teams notification</Label>
                </div>
                <Switch
                  checked={draft.teamsEnabled}
                  onCheckedChange={(teamsEnabled) =>
                    setDraft((prev) => ({ ...prev, teamsEnabled }))
                  }
                />
              </div>
              {draft.teamsEnabled ? (
                <div className="space-y-1.5">
                  <Label className="text-[10px]">Incoming webhook URL</Label>
                  <div className="flex gap-2">
                    <Input
                      value={draft.teamsWebhookUrl}
                      onChange={(e) => {
                        setTeamsTestStatus(null);
                        setDraft((prev) => ({ ...prev, teamsWebhookUrl: e.target.value }));
                      }}
                      placeholder="Leave empty to use global webhook from Alerts page"
                      className="min-w-0 flex-1"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-9 shrink-0 gap-1.5 text-[11px]"
                      disabled={testTeamsNotification.isPending}
                      onClick={() => testTeamsNotification.mutate()}
                    >
                      {testTeamsNotification.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <MessageSquare className="h-3.5 w-3.5" />
                      )}
                      Test
                    </Button>
                  </div>
                  {teamsTestStatus ? (
                    <p
                      className={cn(
                        'text-[10px]',
                        teamsTestStatus.ok ? 'text-emerald-600' : 'text-red-600'
                      )}
                    >
                      {teamsTestStatus.message}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <Switch
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => setDraft((prev) => ({ ...prev, enabled }))}
                />
                <Label className="text-[11px]">Enabled</Label>
              </div>
              <Button
                size="sm"
                className="h-9 gap-1.5"
                disabled={!canSave || saveAutomation.isPending}
                onClick={() => saveAutomation.mutate()}
              >
                {saveAutomation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <PlusCircle className="h-4 w-4" />
                )}
                {editingId ? 'Update automation' : 'Save automation'}
              </Button>
              {saveAutomation.isError ? (
                <p className="text-[11px] text-red-600">
                  {saveAutomation.error instanceof Error
                    ? saveAutomation.error.message
                    : 'Save failed'}
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-violet-600" />
                <h3 className="text-xs font-semibold text-foreground">Teams card preview</h3>
              </div>
              <Select
                value={previewStatus}
                onValueChange={(value) => setPreviewStatus(value as 'Success' | 'Failed')}
              >
                <SelectTrigger className="h-8 w-[110px] text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Success">Success</SelectItem>
                  <SelectItem value="Failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <TeamsNotificationPreview
              title={draft.name.trim() || 'Security Scan Report'}
              scanTypes={previewScanTypes}
              repositories={previewRepositories}
              urls={previewUrls}
              status={previewStatus}
              reportLinks={draft.s3Enabled ? previewReportLinks : []}
              scheduleSummary={draftScheduleSummary}
              s3Bucket={draft.s3Enabled ? draft.s3Bucket || 'my-security-reports' : undefined}
            />
          </div>
        </div>
      </GlassPanel>

      <GlassPanel className="p-5">
        <h3 className="mb-3 text-sm font-semibold text-foreground">Saved automations</h3>
        <SecurityAutomationSavedList
          automations={automations}
          resources={resources}
          togglePending={toggleAutomation.isPending}
          deletePending={deleteAutomation.isPending}
          onToggle={(id, enabled) => toggleAutomation.mutate({ id, enabled })}
          onEdit={(row) => {
            setEditingId(row.id);
            setS3BucketStatus(null);
            setDraft(draftFromAutomation(row));
          }}
          onDelete={(id) => deleteAutomation.mutate(id)}
        />
      </GlassPanel>
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Database, Fingerprint, Loader2, RefreshCcw } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch } from '@/lib/api-client';
import { GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { AdminSettings } from '@/components/pod-scheduler/admin-settings-panel';

interface ResourceAuditRebuildStatus {
  running: boolean;
  phase: string;
  message: string | null;
  error: string | null;
  auditBefore: number;
  auditAfter: number;
  linked: number;
  unlinkedAfter: number;
}

const RESOURCE_AUDIT_RETENTION_PRESETS: {
  label: string;
  amount: number;
  unit: 'weeks' | 'months' | 'years';
}[] = [
  { label: '1 week', amount: 1, unit: 'weeks' },
  { label: '2 weeks', amount: 2, unit: 'weeks' },
  { label: '1 month', amount: 1, unit: 'months' },
  { label: '3 months', amount: 3, unit: 'months' },
  { label: '6 months', amount: 6, unit: 'months' },
  { label: '1 year', amount: 1, unit: 'years' },
  { label: '2 years', amount: 2, unit: 'years' },
];

export function AdminRetentionPanel() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch<{ settings: AdminSettings }>('/api/admin/settings'),
  });

  const settings = data?.settings;

  const [activityLogRetentionDays, setActivityLogRetentionDays] = useState(90);
  const [nodeSampleRetentionDays, setNodeSampleRetentionDays] = useState(90);
  const [nodeSampleDataStartDate, setNodeSampleDataStartDate] = useState('');
  const [nodeSampleDataStartTime, setNodeSampleDataStartTime] = useState('00:00');
  const [resourceAuditRetentionAmount, setResourceAuditRetentionAmount] = useState(3);
  const [resourceAuditRetentionUnit, setResourceAuditRetentionUnit] = useState<
    'weeks' | 'months' | 'years'
  >('months');
  const [resourceAuditDataStartDate, setResourceAuditDataStartDate] = useState('2026-06-01');
  const [saveFeedback, setSaveFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [rebuildFeedback, setRebuildFeedback] = useState<{ ok: boolean; message: string } | null>(
    null
  );
  const [rebuildRunning, setRebuildRunning] = useState(false);
  const rebuildPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!settings) return;
    setActivityLogRetentionDays(settings.activityLogRetentionDays);
    setNodeSampleRetentionDays(settings.nodeSampleRetentionDays);
    setNodeSampleDataStartDate(settings.nodeSampleDataStartDate);
    setNodeSampleDataStartTime(settings.nodeSampleDataStartTime);
    setResourceAuditRetentionAmount(settings.resourceAuditRetentionAmount);
    setResourceAuditRetentionUnit(settings.resourceAuditRetentionUnit);
    setResourceAuditDataStartDate(settings.resourceAuditDataStartDate);
  }, [settings]);

  const retentionPresetValue = `${resourceAuditRetentionAmount}:${resourceAuditRetentionUnit}`;
  const matchedPreset = RESOURCE_AUDIT_RETENTION_PRESETS.find(
    (preset) => `${preset.amount}:${preset.unit}` === retentionPresetValue
  );

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ settings: AdminSettings }>('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          activityLogRetentionDays,
          nodeSampleRetentionDays,
          nodeSampleDataStartDate,
          nodeSampleDataStartTime,
          resourceAuditRetentionAmount,
          resourceAuditRetentionUnit,
          resourceAuditDataStartDate,
        }),
      }),
    onMutate: () => setSaveFeedback(null),
    onSuccess: () => {
      setSaveFeedback({ ok: true, message: 'Retention settings saved' });
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      queryClient.invalidateQueries({ queryKey: ['resource-audit'] });
      queryClient.invalidateQueries({ queryKey: ['resource-audit-summary'] });
      queryClient.invalidateQueries({ queryKey: ['node-changes'] });
      queryClient.invalidateQueries({ queryKey: ['pod-changes'] });
      queryClient.invalidateQueries({ queryKey: ['node-count-trend'] });
    },
    onError: (err: Error) => {
      setSaveFeedback({
        ok: false,
        message: err.message || 'Failed to save retention settings',
      });
    },
  });

  const stopRebuildPolling = () => {
    if (rebuildPollRef.current) {
      clearInterval(rebuildPollRef.current);
      rebuildPollRef.current = null;
    }
  };

  const ensureRebuildPolling = () => {
    if (rebuildPollRef.current) return;
    rebuildPollRef.current = setInterval(() => {
      void pollRebuildStatus();
    }, 3000);
  };

  const pollRebuildStatus = async () => {
    try {
      const data = await apiFetch<{ ok: boolean; status: ResourceAuditRebuildStatus }>(
        '/api/admin/resource-audit/rebuild'
      );
      const status = data.status;
      if (status.running) {
        setRebuildRunning(true);
        setRebuildFeedback({
          ok: true,
          message: status.message || 'Rebuilding Resource Changes…',
        });
        ensureRebuildPolling();
        if (status.auditAfter > 0) {
          queryClient.invalidateQueries({ queryKey: ['resource-audit'] });
          queryClient.invalidateQueries({ queryKey: ['resource-audit-summary'] });
        }
        return;
      }

      stopRebuildPolling();
      setRebuildRunning(false);

      if (status.phase === 'done') {
        setRebuildFeedback({
          ok: true,
          message: status.message || `Rebuild complete — ${status.auditAfter} row(s) visible`,
        });
        queryClient.invalidateQueries({ queryKey: ['resource-audit'] });
        queryClient.invalidateQueries({ queryKey: ['resource-audit-summary'] });
      } else if (status.phase === 'failed') {
        setRebuildFeedback({
          ok: false,
          message: status.error || status.message || 'Rebuild failed',
        });
      }
    } catch (err) {
      stopRebuildPolling();
      setRebuildRunning(false);
      setRebuildFeedback({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to check rebuild status',
      });
    }
  };

  useEffect(() => {
    void pollRebuildStatus();
    return () => stopRebuildPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rebuildMutation = useMutation({
    mutationFn: () =>
      apiFetch<{
        ok: boolean;
        started?: boolean;
        alreadyRunning?: boolean;
        message: string;
        status: ResourceAuditRebuildStatus;
      }>('/api/admin/resource-audit/rebuild', { method: 'POST' }),
    onMutate: () => setRebuildFeedback(null),
    onSuccess: (data) => {
      setRebuildFeedback({
        ok: true,
        message: data.message || 'Rebuild started in the background…',
      });
      setRebuildRunning(true);
      void pollRebuildStatus();
    },
    onError: (err: Error) => {
      setRebuildRunning(false);
      setRebuildFeedback({
        ok: false,
        message: err.message || 'Rebuild failed',
      });
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-7 w-7 animate-spin text-blue-500/50" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <GlassPanel className="p-5">
        <PanelHeader title="Activity Logs" icon={Database} />
        <div className="mt-4 space-y-2">
          <Label>Retention period (days)</Label>
          <Input
            type="number"
            min={1}
            max={3650}
            value={activityLogRetentionDays}
            onChange={(e) => setActivityLogRetentionDays(parseInt(e.target.value, 10) || 90)}
          />
          <p className="text-[11px] text-muted-foreground">
            Activity logs older than this are removed automatically. Users only see logs within this window.
          </p>
        </div>
      </GlassPanel>

      <GlassPanel className="p-5">
        <PanelHeader title="Node & pod count samples" icon={Boxes} accent="violet" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Retention period (days)</Label>
            <Input
              type="number"
              min={7}
              max={3650}
              value={nodeSampleRetentionDays}
              onChange={(e) => setNodeSampleRetentionDays(parseInt(e.target.value, 10) || 90)}
            />
            <p className="text-[11px] text-muted-foreground">
              Hourly node and pod count samples for Node count trend, Node changes, and Pod changes are
              kept for this many days. Minimum 7 days.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Capture start date</Label>
            <Input
              type="date"
              value={nodeSampleDataStartDate}
              onChange={(e) => setNodeSampleDataStartDate(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Node and pod count capture begins on this date. Leave empty to use retention window only.
            </p>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Capture start time (IST)</Label>
            <Input
              type="time"
              value={nodeSampleDataStartTime}
              onChange={(e) => setNodeSampleDataStartTime(e.target.value)}
              disabled={!nodeSampleDataStartDate}
            />
            <p className="text-[11px] text-muted-foreground">
              First hourly sample is counted from this time on the start date. Samples before this are
              removed when saved.
            </p>
          </div>
        </div>
      </GlassPanel>

      <GlassPanel className="p-5">
        <PanelHeader title="Resource Changes" icon={Fingerprint} />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label>Retention period</Label>
            <Select
              value={matchedPreset ? retentionPresetValue : 'custom'}
              onValueChange={(value) => {
                if (value === 'custom') return;
                const [amount, unit] = value.split(':');
                setResourceAuditRetentionAmount(parseInt(amount, 10) || 3);
                setResourceAuditRetentionUnit(unit as 'weeks' | 'months' | 'years');
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select retention" />
              </SelectTrigger>
              <SelectContent>
                {RESOURCE_AUDIT_RETENTION_PRESETS.map((preset) => (
                  <SelectItem key={preset.label} value={`${preset.amount}:${preset.unit}`}>
                    {preset.label}
                  </SelectItem>
                ))}
                {!matchedPreset && (
                  <SelectItem value="custom">
                    Custom ({resourceAuditRetentionAmount}{' '}
                    {resourceAuditRetentionAmount === 1
                      ? resourceAuditRetentionUnit.slice(0, -1)
                      : resourceAuditRetentionUnit}
                    )
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Data older than this window is removed automatically from Resource Changes and git history.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Custom amount</Label>
            <Input
              type="number"
              min={1}
              max={
                resourceAuditRetentionUnit === 'weeks'
                  ? 52
                  : resourceAuditRetentionUnit === 'months'
                    ? 36
                    : 10
              }
              value={resourceAuditRetentionAmount}
              onChange={(e) => setResourceAuditRetentionAmount(parseInt(e.target.value, 10) || 1)}
            />
          </div>
          <div className="space-y-2">
            <Label>Custom unit</Label>
            <Select
              value={resourceAuditRetentionUnit}
              onValueChange={(value) =>
                setResourceAuditRetentionUnit(value as 'weeks' | 'months' | 'years')
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="weeks">Weeks</SelectItem>
                <SelectItem value="months">Months</SelectItem>
                <SelectItem value="years">Years</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Earliest data date</Label>
            <Input
              type="date"
              value={resourceAuditDataStartDate}
              onChange={(e) => setResourceAuditDataStartDate(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Resource Changes never shows or keeps data before this date.
            </p>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Rebuild from git history</Label>
            <p className="text-[11px] text-muted-foreground">
              Re-link Resource Changes from cloned Bitbucket repos. Runs in the background and may take
              several minutes on EC2.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              {rebuildFeedback && (
                <p
                  className={cn(
                    'text-xs',
                    rebuildFeedback.ok
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-red-700 dark:text-red-400'
                  )}
                >
                  {rebuildFeedback.message}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => rebuildMutation.mutate()}
                disabled={rebuildRunning || rebuildMutation.isPending}
              >
                {rebuildRunning || rebuildMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCcw className="h-4 w-4" />
                )}
                Rebuild Resource Changes
              </Button>
            </div>
          </div>
        </div>
      </GlassPanel>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {saveFeedback && (
          <p
            className={cn(
              'text-xs',
              saveFeedback.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'
            )}
          >
            {saveFeedback.message}
          </p>
        )}
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            'Save retention settings'
          )}
        </Button>
      </div>
    </div>
  );
}

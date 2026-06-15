'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Database,
  Fingerprint,
  Globe2,
  Icons,
  Loader2,
  Save,
  ServerCog,
  ShieldCheck,
} from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch } from '@/lib/api-client';
import { TECH_ICONS } from '@/lib/tech-icons';
import { ArgoCDInstancesPanel } from '@/components/pod-scheduler/argocd-instances-panel';
import { BitbucketIntegrationPanel } from '@/components/pod-scheduler/bitbucket-integration-panel';
import { GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const SECRET_PLACEHOLDER = '••••••••';

export interface AdminSettings {
  kubeconfigSet: boolean;
  googleAllowedDomain: string;
  demoMode: boolean;
  redisUrl: string;
  apiBaseUrl: string;
  activityLogRetentionDays: number;
  resourceAuditRetentionAmount: number;
  resourceAuditRetentionUnit: 'weeks' | 'months' | 'years';
  resourceAuditDataStartDate: string;
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

export function AdminSettingsPanel() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch<{ settings: AdminSettings }>('/api/admin/settings'),
  });

  const settings = data?.settings;

  const [kubeconfigBase64, setKubeconfigBase64] = useState('');
  const [googleAllowedDomain, setGoogleAllowedDomain] = useState('');
  const [demoMode, setDemoMode] = useState(false);
  const [redisUrl, setRedisUrl] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [activityLogRetentionDays, setActivityLogRetentionDays] = useState(90);
  const [resourceAuditRetentionAmount, setResourceAuditRetentionAmount] = useState(3);
  const [resourceAuditRetentionUnit, setResourceAuditRetentionUnit] = useState<
    'weeks' | 'months' | 'years'
  >('months');
  const [resourceAuditDataStartDate, setResourceAuditDataStartDate] = useState('2026-06-01');

  useEffect(() => {
    if (!settings) return;
    setKubeconfigBase64(settings.kubeconfigSet ? SECRET_PLACEHOLDER : '');
    setGoogleAllowedDomain(settings.googleAllowedDomain);
    setDemoMode(settings.demoMode);
    setRedisUrl(settings.redisUrl);
    setApiBaseUrl(settings.apiBaseUrl);
    setActivityLogRetentionDays(settings.activityLogRetentionDays);
    setResourceAuditRetentionAmount(settings.resourceAuditRetentionAmount);
    setResourceAuditRetentionUnit(settings.resourceAuditRetentionUnit);
    setResourceAuditDataStartDate(settings.resourceAuditDataStartDate);
  }, [settings]);

  const retentionPresetValue = `${resourceAuditRetentionAmount}:${resourceAuditRetentionUnit}`;
  const matchedPreset = RESOURCE_AUDIT_RETENTION_PRESETS.find(
    (preset) => `${preset.amount}:${preset.unit}` === retentionPresetValue
  );

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        googleAllowedDomain,
        demoMode,
        redisUrl,
        apiBaseUrl,
        activityLogRetentionDays,
        resourceAuditRetentionAmount,
        resourceAuditRetentionUnit,
        resourceAuditDataStartDate,
      };
      if (kubeconfigBase64 && kubeconfigBase64 !== SECRET_PLACEHOLDER) {
        payload.kubeconfigBase64 = kubeconfigBase64;
      }
      return apiFetch<{ settings: AdminSettings }>('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      queryClient.invalidateQueries({ queryKey: ['public-settings'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      queryClient.invalidateQueries({ queryKey: ['argocd-apps'] });
      queryClient.invalidateQueries({ queryKey: ['infrastructure'] });
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      queryClient.invalidateQueries({ queryKey: ['resource-audit'] });
      queryClient.invalidateQueries({ queryKey: ['resource-audit-summary'] });
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
        <ArgoCDInstancesPanel />
      </GlassPanel>

      <GlassPanel className="p-5">
        <BitbucketIntegrationPanel />
      </GlassPanel>

      <GlassPanel className="p-5">
        <PanelHeader
          title="Kubernetes"
          brandIconSrc={TECH_ICONS.kubernetes}
          brandIconAlt="Kubernetes"
          accent="sky"
        />
        <div className="mt-4 space-y-2">
          <Label>Global kubeconfig (base64) — optional</Label>
            <textarea
              value={kubeconfigBase64}
              onChange={(e) => setKubeconfigBase64(e.target.value)}
              placeholder={settings?.kubeconfigSet ? 'Leave unchanged or paste new base64 kubeconfig' : 'Only needed if you have not added clusters under Clusters'}
              rows={3}
              className={cn(
                'flex w-full rounded-xl border border-border bg-background px-4 py-2 font-mono text-xs text-foreground shadow-sm',
                'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30'
              )}
            />
            <p className="text-[11px] text-muted-foreground">
              Not required when clusters are added via Clusters → Add Cluster. Each registered cluster stores its own kubeconfig.
              Use this field only as a global fallback for legacy flows.
            </p>
        </div>
      </GlassPanel>

      <GlassPanel className="p-5">
        <PanelHeader title="Authentication" icon={ShieldCheck} />
        <div className="mt-4 space-y-2">
          <Label>Google Allowed Domain</Label>
          <Input
            value={googleAllowedDomain}
            onChange={(e) => setGoogleAllowedDomain(e.target.value)}
            placeholder="yourcompany.com"
          />
          <p className="text-[11px] text-muted-foreground">
            Only users with this email domain can sign in. Google Client ID/Secret stay in <code>.env</code>.
          </p>
        </div>
      </GlassPanel>

      <GlassPanel className="p-5">
        <PanelHeader title="System" icon={ServerCog} />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3 sm:col-span-2">
            <div>
              <p className="text-sm font-medium text-foreground">Demo mode</p>
              <p className="text-xs text-muted-foreground">Uses mock data and bypasses Google login — off by default</p>
            </div>
            <Switch checked={demoMode} onCheckedChange={setDemoMode} />
          </div>
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <AppIcon icon={Database} size="sm" /> Redis URL
            </Label>
            <Input
              value={redisUrl}
              onChange={(e) => setRedisUrl(e.target.value)}
              placeholder="redis://localhost:6379"
            />
          </div>
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <AppIcon icon={Globe2} size="sm" /> API Base URL
            </Label>
            <Input
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.target.value)}
              placeholder="Leave empty for same host"
            />
          </div>
        </div>
      </GlassPanel>

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
              Data older than this window is removed automatically from Resource Changes and git
              history.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Custom amount</Label>
            <Input
              type="number"
              min={1}
              max={resourceAuditRetentionUnit === 'weeks' ? 52 : resourceAuditRetentionUnit === 'months' ? 36 : 10}
              value={resourceAuditRetentionAmount}
              onChange={(e) =>
                setResourceAuditRetentionAmount(parseInt(e.target.value, 10) || 1)
              }
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
              Resource Changes never shows or keeps data before this date. Default: 1 June 2026.
            </p>
          </div>
        </div>
      </GlassPanel>

      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <AppIcon icon={Icons.actions.save} />
          )}
          Save Settings
        </Button>
      </div>
    </div>
  );
}

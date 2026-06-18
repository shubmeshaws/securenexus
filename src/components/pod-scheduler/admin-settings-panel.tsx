'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Database,
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
import { AwsCredentialsPanel } from '@/components/pod-scheduler/aws-credentials-panel';
import { BitbucketIntegrationPanel } from '@/components/pod-scheduler/bitbucket-integration-panel';
import { DevOpsContactsPanel } from '@/components/pod-scheduler/devops-contacts-panel';
import { NewUserAccessSettingCard } from '@/components/pod-scheduler/new-user-access-setting';
import { GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

const SECRET_PLACEHOLDER = '••••••••';

export interface AdminSettings {
  kubeconfigSet: boolean;
  googleAllowedDomain: string;
  demoMode: boolean;
  redisUrl: string;
  apiBaseUrl: string;
  activityLogRetentionDays: number;
  nodeSampleRetentionDays: number;
  nodeSampleDataStartDate: string;
  nodeSampleDataStartTime: string;
  resourceAuditRetentionAmount: number;
  resourceAuditRetentionUnit: 'weeks' | 'months' | 'years';
  resourceAuditDataStartDate: string;
}

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
  const [saveFeedback, setSaveFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!settings) return;
    setKubeconfigBase64(settings.kubeconfigSet ? SECRET_PLACEHOLDER : '');
    setGoogleAllowedDomain(settings.googleAllowedDomain);
    setDemoMode(settings.demoMode);
    setRedisUrl(settings.redisUrl);
    setApiBaseUrl(settings.apiBaseUrl);
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        googleAllowedDomain,
        demoMode,
        redisUrl,
        apiBaseUrl,
      };
      if (kubeconfigBase64 && kubeconfigBase64 !== SECRET_PLACEHOLDER) {
        payload.kubeconfigBase64 = kubeconfigBase64;
      }
      return apiFetch<{ settings: AdminSettings }>('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    },
    onMutate: () => setSaveFeedback(null),
    onSuccess: () => {
      setSaveFeedback({ ok: true, message: 'Changes saved' });
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      queryClient.invalidateQueries({ queryKey: ['public-settings'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      queryClient.invalidateQueries({ queryKey: ['argocd-apps'] });
      queryClient.invalidateQueries({ queryKey: ['infrastructure'] });
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
    },
    onError: (err: Error) => {
      setSaveFeedback({
        ok: false,
        message: err.message || 'Failed to save settings',
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
        <PanelHeader title="Authentication" icon={ShieldCheck} />
        <div className="mt-4 space-y-4">
          <NewUserAccessSettingCard compact />
          <div className="space-y-2">
            <Label>Google Allowed Domain</Label>
            <Input
              value={googleAllowedDomain}
              onChange={(e) => setGoogleAllowedDomain(e.target.value)}
              placeholder="yourcompany.com"
            />
            <p className="text-[11px] text-muted-foreground">
              Only users with this email domain can sign in. Google Client ID/Secret stay in{' '}
              <code>.env</code>.
            </p>
          </div>
        </div>
      </GlassPanel>

      <GlassPanel className="p-5">
        <ArgoCDInstancesPanel />
      </GlassPanel>

      <GlassPanel className="p-5">
        <DevOpsContactsPanel />
      </GlassPanel>

      <GlassPanel className="p-5">
        <BitbucketIntegrationPanel />
      </GlassPanel>

      <GlassPanel className="p-5">
        <AwsCredentialsPanel />
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
            placeholder={
              settings?.kubeconfigSet
                ? 'Leave unchanged or paste new base64 kubeconfig'
                : 'Only needed if you have not added clusters under Clusters'
            }
            rows={3}
            className={cn(
              'flex w-full rounded-xl border border-border bg-background px-4 py-2 font-mono text-xs text-foreground shadow-sm',
              'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30'
            )}
          />
          <p className="text-[11px] text-muted-foreground">
            Not required when clusters are added via Clusters → Add Cluster. Each registered cluster
            stores its own kubeconfig. Use this field only as a global fallback for legacy flows.
          </p>
        </div>
      </GlassPanel>

      <GlassPanel className="p-5">
        <PanelHeader title="System" icon={ServerCog} />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3 sm:col-span-2">
            <div>
              <p className="text-sm font-medium text-foreground">Demo mode</p>
              <p className="text-xs text-muted-foreground">
                Uses mock data and bypasses Google login — off by default
              </p>
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
            <AppIcon icon={Icons.actions.save} />
          )}
          Save Settings
        </Button>
      </div>
    </div>
  );
}

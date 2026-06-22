'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck,
  BellRing,
  Bolt,
  CircleX,
  Icons,
  Loader2,
  Mail,
  MessageSquare,
  Save,
  SendHorizonal,
  Webhook,
} from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { ModernIcon } from '@/components/ui/modern-icon';
import { apiFetch } from '@/lib/api-client';
import { PageHeader, GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  TeamsCardPreview,
  IN_APP_ALERT_TYPES,
} from '@/components/pod-scheduler/teams-card-preview';
import type { NotificationType } from '@/lib/notifications';
import { cn } from '@/lib/utils';
import type { ActivityAction } from '@/lib/activity';

const SECRET_PLACEHOLDER = '••••••••';

const EVENT_LABELS: Record<ActivityAction, string> = {
  'schedule-shutdown': 'Scheduled shutdown',
  'schedule-startup': 'Scheduled startup',
  'schedule-run': 'Manual schedule run',
  'instant-start': 'Instant start',
  'instant-stop': 'Instant stop',
  'scale-down': 'Scale down',
  'scale-up': 'Scale up',
  'sync-off': 'Sync disabled',
  'sync-on': 'Sync enabled',
  'infra-shutdown': 'Infrastructure stop',
  'infra-startup': 'Infrastructure start',
  'resource-change': 'Resource increase detected',
  'alert-broadcast': 'Admin broadcast',
};

interface AlertSettings {
  inAppEnabled: boolean;
  emailEnabled: boolean;
  teamsEnabled: boolean;
  emailRecipients: string[];
  emailFrom: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpSecure: boolean;
  teamsWebhookSet: boolean;
  smtpPasswordSet: boolean;
  events: ActivityAction[];
  resourceChangeThresholdUsd: number;
}

interface TestResult {
  ok: boolean;
  message: string;
}

type SaveScope = 'all' | 'email' | 'teams' | 'toggles';

function parseRecipients(raw: string): string[] {
  return raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

export function AlertsContent() {
  const queryClient = useQueryClient();
  const hydratedRef = useRef(false);

  const { data, isLoading } = useQuery({
    queryKey: ['alert-settings'],
    queryFn: () =>
      apiFetch<{ settings: AlertSettings; availableEvents: ActivityAction[] }>(
        '/api/admin/alerts'
      ),
  });

  const settings = data?.settings;
  const availableEvents = (data?.availableEvents ?? []).filter(
    (e) => e !== 'alert-broadcast'
  );

  const [inAppEnabled, setInAppEnabled] = useState(true);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [teamsEnabled, setTeamsEnabled] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState('');
  const [emailFrom, setEmailFrom] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [teamsWebhookUrl, setTeamsWebhookUrl] = useState('');
  const [events, setEvents] = useState<Set<ActivityAction>>(new Set());
  const [resourceChangeThresholdUsd, setResourceChangeThresholdUsd] = useState('5');
  const [feedback, setFeedback] = useState<TestResult | null>(null);

  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [broadcastType, setBroadcastType] = useState<NotificationType>('info');

  useEffect(() => {
    if (!settings || hydratedRef.current) return;
    setInAppEnabled(settings.inAppEnabled);
    setEmailEnabled(settings.emailEnabled);
    setTeamsEnabled(settings.teamsEnabled);
    setEmailRecipients(settings.emailRecipients.join(', '));
    setEmailFrom(settings.emailFrom);
    setSmtpHost(settings.smtpHost);
    setSmtpPort(String(settings.smtpPort || 587));
    setSmtpUser(settings.smtpUser);
    setSmtpPassword(settings.smtpPasswordSet ? SECRET_PLACEHOLDER : '');
    setTeamsWebhookUrl(settings.teamsWebhookSet ? SECRET_PLACEHOLDER : '');
    setSmtpSecure(settings.smtpSecure);
    setEvents(new Set(settings.events.filter((e) => e !== 'alert-broadcast')));
    setResourceChangeThresholdUsd(String(settings.resourceChangeThresholdUsd ?? 5));
    hydratedRef.current = true;
  }, [settings]);

  const buildPayload = useCallback(
    (scope: SaveScope) => {
      const base = {
        inAppEnabled,
        emailEnabled,
        teamsEnabled,
        events: Array.from(events),
        resourceChangeThresholdUsd: parseFloat(resourceChangeThresholdUsd) || 5,
      };

      if (scope === 'toggles') return base;

      const payload: Record<string, unknown> = { ...base };

      if (scope === 'all' || scope === 'email') {
        payload.emailRecipients = parseRecipients(emailRecipients);
        payload.emailFrom = emailFrom;
        payload.smtpHost = smtpHost;
        payload.smtpPort = parseInt(smtpPort, 10) || 587;
        payload.smtpUser = smtpUser;
        payload.smtpSecure = smtpSecure;
        if (smtpPassword && smtpPassword !== SECRET_PLACEHOLDER) {
          payload.smtpPassword = smtpPassword;
        }
      }

      if (scope === 'all' || scope === 'teams') {
        if (teamsWebhookUrl && teamsWebhookUrl !== SECRET_PLACEHOLDER) {
          payload.teamsWebhookUrl = teamsWebhookUrl;
        }
      }

      return payload;
    },
    [
      inAppEnabled,
      emailEnabled,
      teamsEnabled,
      events,
      emailRecipients,
      emailFrom,
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPassword,
      smtpSecure,
      teamsWebhookUrl,
      resourceChangeThresholdUsd,
    ]
  );

  const saveMutation = useMutation({
    mutationFn: (scope: SaveScope) =>
      apiFetch<{ settings: AlertSettings }>('/api/admin/alerts', {
        method: 'PUT',
        body: JSON.stringify(buildPayload(scope)),
      }),
    onSuccess: (res, scope) => {
      hydratedRef.current = false;
      queryClient.setQueryData(['alert-settings'], (old: typeof data) =>
        old ? { ...old, settings: res.settings } : old
      );
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      const label =
        scope === 'email' ? 'Email settings saved' : scope === 'teams' ? 'Teams settings saved' : 'Settings saved';
      setFeedback({ ok: true, message: label });
      if (res.settings.smtpPasswordSet) setSmtpPassword(SECRET_PLACEHOLDER);
      if (res.settings.teamsWebhookSet) setTeamsWebhookUrl(SECRET_PLACEHOLDER);
      hydratedRef.current = true;
    },
    onError: (err: Error) => {
      setFeedback({ ok: false, message: err.message || 'Failed to save settings' });
    },
  });

  const broadcastMutation = useMutation({
    mutationFn: () =>
      apiFetch<TestResult>('/api/admin/alerts/broadcast', {
        method: 'POST',
        body: JSON.stringify({
          title: broadcastTitle,
          message: broadcastMessage,
          type: broadcastType,
        }),
      }),
    onSuccess: (r) => {
      setFeedback(r);
      setBroadcastTitle('');
      setBroadcastMessage('');
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (err: Error) => {
      setFeedback({ ok: false, message: err.message || 'Broadcast failed' });
    },
  });

  const testTeamsMutation = useMutation({
    mutationFn: async () => {
      if (teamsWebhookUrl && teamsWebhookUrl !== SECRET_PLACEHOLDER) {
        await saveMutation.mutateAsync('teams');
      }
      return apiFetch<TestResult>('/api/admin/alerts/test-teams', {
        method: 'POST',
        body: JSON.stringify({
          teamsWebhookUrl:
            teamsWebhookUrl !== SECRET_PLACEHOLDER ? teamsWebhookUrl : undefined,
        }),
      });
    },
    onSuccess: setFeedback,
    onError: (err: Error) => setFeedback({ ok: false, message: err.message }),
  });

  const testEmailMutation = useMutation({
    mutationFn: async () => {
      await saveMutation.mutateAsync('email');
      return apiFetch<TestResult>('/api/admin/alerts/test-email', { method: 'POST' });
    },
    onSuccess: setFeedback,
    onError: (err: Error) => setFeedback({ ok: false, message: err.message }),
  });

  function toggleEvent(action: ActivityAction) {
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(action)) next.delete(action);
      else next.add(action);
      return next;
    });
  }

  function handleToggleChange(
    field: 'inApp' | 'email' | 'teams',
    value: boolean,
    setter: (v: boolean) => void
  ) {
    setter(value);
    const next = {
      inAppEnabled: field === 'inApp' ? value : inAppEnabled,
      emailEnabled: field === 'email' ? value : emailEnabled,
      teamsEnabled: field === 'teams' ? value : teamsEnabled,
      events: Array.from(events),
    };
    apiFetch<{ settings: AlertSettings }>('/api/admin/alerts', {
      method: 'PUT',
      body: JSON.stringify(next),
    })
      .then((res) => {
        queryClient.setQueryData(['alert-settings'], (old: typeof data) =>
          old ? { ...old, settings: res.settings } : old
        );
      })
      .catch(() => {
        setFeedback({ ok: false, message: 'Failed to save toggle — click Save to retry' });
      });
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-7 w-7 animate-spin text-blue-500/50" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Alerts"
        description="Configure in-app, email, and Microsoft Teams notifications. Settings persist across sessions."
        action={
          <Button
            size="sm"
            onClick={() => saveMutation.mutate('all')}
            disabled={saveMutation.isPending}
          >
            <AppIcon icon={Save} size="sm" />
            Save all
          </Button>
        }
      />

      {feedback && (
        <div
          className={cn(
            'flex items-center gap-2 rounded-xl border px-4 py-3 text-sm',
            feedback.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
              : 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
          )}
        >
          <AppIcon icon={feedback.ok ? BadgeCheck : CircleX} size="sm" />
          {feedback.message}
          <button
            type="button"
            className="ml-auto text-xs opacity-60 hover:opacity-100"
            onClick={() => setFeedback(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <GlassPanel>
        <PanelHeader title="Event triggers" icon={Icons.actions.filter} accent="violet" />
        <div className="flex flex-wrap gap-2 p-5">
          {availableEvents.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => toggleEvent(action)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                events.has(action)
                  ? 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-200'
                  : 'border-border bg-secondary/40 text-muted-foreground hover:bg-accent'
              )}
            >
              {EVENT_LABELS[action] ?? action}
            </button>
          ))}
        </div>
        <div className="border-t border-border px-5 py-4">
          <Field label="Resource change alert threshold (USD/day)">
            <Input
              type="number"
              min={0}
              step={0.5}
              value={resourceChangeThresholdUsd}
              onChange={(e) => setResourceChangeThresholdUsd(e.target.value)}
              className="max-w-[200px]"
            />
          </Field>
          <p className="mt-2 text-xs text-muted-foreground">
            Teams/email alert when a single sync&apos;s cumulative resource increase exceeds this
            value (default $5/day).
          </p>
        </div>
        <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          When these events occur, all enabled channels below are notified automatically.
        </p>
      </GlassPanel>

      <div className="grid gap-4 lg:grid-cols-3">
        <ChannelCard
          accent="blue"
          icon={BellRing}
          title="In-app notifications"
          description="Bell icon for all signed-in users with live unread count."
          enabled={inAppEnabled}
          onEnabledChange={(v) => handleToggleChange('inApp', v, setInAppEnabled)}
          onSave={() => saveMutation.mutate('toggles')}
          saving={saveMutation.isPending}
        >
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Event alerts and admin broadcasts appear in every user&apos;s bell dropdown. The badge
              shows unread count (refreshes every 30s).
            </p>

            <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-3">
              <p className="text-xs font-semibold text-foreground">Send broadcast to all users</p>
              <Field label="Alert type">
                <div className="flex flex-wrap gap-2">
                  {IN_APP_ALERT_TYPES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setBroadcastType(t.id)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                        broadcastType === t.id
                          ? t.style
                          : 'border-border text-muted-foreground hover:bg-accent'
                      )}
                    >
                      <AppIcon icon={t.icon} size="xs" />
                      {t.label}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Title">
                <Input
                  value={broadcastTitle}
                  onChange={(e) => setBroadcastTitle(e.target.value)}
                  placeholder="Maintenance tonight at 10 PM"
                />
              </Field>
              <Field label="Message">
                <textarea
                  value={broadcastMessage}
                  onChange={(e) => setBroadcastMessage(e.target.value)}
                  placeholder="All schedules will pause during the maintenance window..."
                  rows={3}
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </Field>
              <Button
                size="sm"
                className="w-full gap-1.5"
                disabled={
                  !inAppEnabled ||
                  !broadcastTitle.trim() ||
                  !broadcastMessage.trim() ||
                  broadcastMutation.isPending
                }
                onClick={() => broadcastMutation.mutate()}
              >
                {broadcastMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <AppIcon icon={SendHorizonal} size="sm" />
                )}
                Send to all users
              </Button>
            </div>
          </div>
        </ChannelCard>

        <ChannelCard
          accent="emerald"
          icon={Mail}
          title="Email alerts"
          description="HTML emails with colorful cards via SMTP."
          enabled={emailEnabled}
          onEnabledChange={(v) => handleToggleChange('email', v, setEmailEnabled)}
          onSave={() => saveMutation.mutate('email')}
          saving={saveMutation.isPending}
          onTest={() => testEmailMutation.mutate()}
          testing={testEmailMutation.isPending}
        >
          <div className="space-y-3">
            <Field label="Recipients (comma-separated)">
              <Input
                value={emailRecipients}
                onChange={(e) => setEmailRecipients(e.target.value)}
                placeholder="ops@company.com, devops@company.com"
              />
            </Field>
            <Field label="From address">
              <Input
                value={emailFrom}
                onChange={(e) => setEmailFrom(e.target.value)}
                placeholder="alerts@company.com"
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="SMTP host">
                <Input
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  placeholder="smtp.office365.com"
                />
              </Field>
              <Field label="Port">
                <Input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="587" />
              </Field>
            </div>
            <Field label="SMTP user">
              <Input
                value={smtpUser}
                onChange={(e) => setSmtpUser(e.target.value)}
                placeholder="alerts@company.com"
              />
            </Field>
            <Field label="SMTP password">
              <Input
                type="password"
                value={smtpPassword}
                onChange={(e) => setSmtpPassword(e.target.value)}
                placeholder={settings?.smtpPasswordSet ? 'Saved (enter to change)' : 'Password'}
              />
            </Field>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={smtpSecure} onCheckedChange={setSmtpSecure} />
              Use TLS (port 465)
            </label>
          </div>
        </ChannelCard>

        <ChannelCard
          accent="violet"
          icon={MessageSquare}
          title="Microsoft Teams"
          description="Adaptive Card webhooks with emphasis style."
          enabled={teamsEnabled}
          onEnabledChange={(v) => handleToggleChange('teams', v, setTeamsEnabled)}
          onSave={() => saveMutation.mutate('teams')}
          saving={saveMutation.isPending}
          onTest={() => testTeamsMutation.mutate()}
          testing={testTeamsMutation.isPending}
        >
          <div className="space-y-3">
            <Field label="Incoming webhook URL">
              <Input
                value={teamsWebhookUrl}
                onChange={(e) => setTeamsWebhookUrl(e.target.value)}
                placeholder="https://outlook.office.com/webhook/..."
                className="font-mono text-xs"
              />
            </Field>
            {settings?.teamsWebhookSet && teamsWebhookUrl === SECRET_PLACEHOLDER && (
              <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
                Webhook URL saved securely
              </p>
            )}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                <AppIcon icon={Webhook} size="sm" className="text-violet-600" />
                Card preview
              </div>
              <TeamsCardPreview />
            </div>
          </div>
        </ChannelCard>
      </div>
    </div>
  );
}

function ChannelCard({
  accent,
  icon: Icon,
  title,
  description,
  enabled,
  onEnabledChange,
  onSave,
  saving,
  onTest,
  testing,
  children,
}: {
  accent: 'blue' | 'emerald' | 'violet';
  icon: typeof BellRing;
  title: string;
  description: string;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  onSave: () => void;
  saving: boolean;
  onTest?: () => void;
  testing?: boolean;
  children: ReactNode;
}) {
  return (
    <GlassPanel className="flex flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-border p-5">
        <div className="flex items-start gap-3">
          <ModernIcon icon={Icon} accent={accent} size="md" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        <Switch checked={enabled} onCheckedChange={onEnabledChange} />
      </div>
      <div className="flex-1 p-5">{children}</div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
        <Badge variant={enabled ? 'success' : 'unknown'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onSave} disabled={saving}>
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <AppIcon icon={Save} size="sm" />
            )}
            Save
          </Button>
          {onTest && (
            <Button variant="outline" size="sm" onClick={onTest} disabled={testing || !enabled}>
              {testing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <AppIcon icon={Bolt} size="sm" />
              )}
              Test
            </Button>
          )}
        </div>
      </div>
    </GlassPanel>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

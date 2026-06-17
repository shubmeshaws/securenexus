'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, UserRoundPlus } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch } from '@/lib/api-client';
import { GlassPanel } from '@/components/pod-scheduler/ui-primitives';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';

export function NewUserAccessSettingCard({ compact = false }: { compact?: boolean }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () =>
      apiFetch<{ settings: { newUserAccessEnabled: boolean } }>('/api/admin/settings'),
  });

  const enabled = data?.settings.newUserAccessEnabled ?? true;

  const saveMutation = useMutation({
    mutationFn: (newUserAccessEnabled: boolean) =>
      apiFetch('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ newUserAccessEnabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
    },
  });

  if (isLoading) {
    return (
      <GlassPanel className="flex items-center justify-center px-4 py-3">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </GlassPanel>
    );
  }

  return (
    <GlassPanel className={compact ? 'px-4 py-3' : 'p-5'}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700 ring-1 ring-blue-200/80 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-0">
            <AppIcon icon={UserRoundPlus} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-foreground">New user access</p>
              <Badge variant={enabled ? 'success' : 'failed'}>
                {enabled ? 'Enabled by default' : 'Disabled by default'}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Controls whether new Google sign-ins get access immediately or see &ldquo;Access
              pending&rdquo; until you enable them below. The first account is always enabled.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs text-muted-foreground">Allow access after login</span>
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => saveMutation.mutate(checked)}
            disabled={saveMutation.isPending}
            aria-label="Enable access for new users by default"
          />
        </div>
      </div>
    </GlassPanel>
  );
}

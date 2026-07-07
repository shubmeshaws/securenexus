'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldCheck } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch } from '@/lib/api-client';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';

export function SecurityModuleSettingCard() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () =>
      apiFetch<{ settings: { securityModuleEnabled: boolean } }>('/api/admin/settings'),
  });

  const enabled = data?.settings.securityModuleEnabled ?? false;

  const saveMutation = useMutation({
    mutationFn: (securityModuleEnabled: boolean) =>
      apiFetch('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ securityModuleEnabled }),
      }),
    onSuccess: (_data, securityModuleEnabled) => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      queryClient.setQueryData(
        ['public-settings'],
        (current: { securityModuleEnabled?: boolean; demoMode?: boolean; apiBaseUrl?: string } | undefined) => ({
          ...(current ?? { demoMode: false, apiBaseUrl: '' }),
          securityModuleEnabled,
        })
      );
      queryClient.invalidateQueries({ queryKey: ['public-settings'] });
    },
  });

  return (
    <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3 sm:col-span-2">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-700 ring-1 ring-violet-200/80 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-0">
          <AppIcon icon={ShieldCheck} />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">Security module</p>
            <Badge variant={enabled ? 'success' : 'secondary'}>
              {enabled ? 'Visible in sidebar' : 'Hidden'}
            </Badge>
            {saveMutation.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Shows the Security section in the sidebar for authorized users — resources, scanner tools, and
            reports. Saves immediately when toggled.
          </p>
        </div>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={(checked) => saveMutation.mutate(checked)}
        disabled={isLoading || saveMutation.isPending}
        aria-label="Enable Security module in sidebar"
      />
    </div>
  );
}

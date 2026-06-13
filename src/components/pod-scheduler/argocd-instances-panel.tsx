'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck,
  Bolt,
  CircleX,
  CloudCog,
  Loader2,
  PenLine,
  PlusCircle,
  Trash2,
} from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch, getAuthToken, type ArgoCDInstance } from '@/lib/api-client';
import { getApiBaseUrl } from '@/lib/client-settings';
import { PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const SECRET_PLACEHOLDER = '••••••••';

interface ArgoCDTestResult {
  ok: boolean;
  message: string;
  appCount?: number;
  clusters?: string[];
}

interface InstanceFormState {
  name: string;
  serverUrl: string;
  token: string;
  insecureTls: boolean;
  enabled: boolean;
  clusterNames: string;
}

const emptyForm = (): InstanceFormState => ({
  name: '',
  serverUrl: '',
  token: '',
  insecureTls: false,
  enabled: true,
  clusterNames: '',
});

export function ArgoCDInstancesPanel() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['argocd-instances'],
    queryFn: () => apiFetch<{ instances: ArgoCDInstance[] }>('/api/admin/argocd-instances'),
  });

  const instances = data?.instances ?? [];
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ArgoCDInstance | null>(null);
  const [form, setForm] = useState<InstanceFormState>(emptyForm());
  const [testResult, setTestResult] = useState<ArgoCDTestResult | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ArgoCDInstance | null>(null);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setTestResult(null);
    setDialogOpen(true);
  };

  const openEdit = (instance: ArgoCDInstance) => {
    setEditing(instance);
    setForm({
      name: instance.name,
      serverUrl: instance.serverUrl,
      token: instance.tokenSet ? SECRET_PLACEHOLDER : '',
      insecureTls: instance.insecureTls,
      enabled: instance.enabled,
      clusterNames: instance.clusterNames.join(', '),
    });
    setTestResult(null);
    setDialogOpen(true);
  };

  const parseClusterNames = (raw: string) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name,
        serverUrl: form.serverUrl,
        insecureTls: form.insecureTls,
        enabled: form.enabled,
        clusterNames: parseClusterNames(form.clusterNames),
        ...(form.token && form.token !== SECRET_PLACEHOLDER ? { token: form.token } : {}),
      };

      if (editing) {
        return apiFetch(`/api/admin/argocd-instances/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      }
      if (!form.token || form.token === SECRET_PLACEHOLDER) {
        throw new Error('API token is required for new instances');
      }
      return apiFetch('/api/admin/argocd-instances', {
        method: 'POST',
        body: JSON.stringify({ ...body, token: form.token }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['argocd-instances'] });
      queryClient.invalidateQueries({ queryKey: ['argocd-apps'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      setDialogOpen(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/admin/argocd-instances/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['argocd-instances'] });
      queryClient.invalidateQueries({ queryKey: ['argocd-apps'] });
      setDeleteTarget(null);
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const token = getAuthToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;

      const url = editing
        ? `${getApiBaseUrl()}/api/admin/argocd-instances/${editing.id}/test`
        : `${getApiBaseUrl()}/api/admin/settings/test-argocd`;

      const payload = editing
        ? {
            serverUrl: form.serverUrl,
            token: form.token || undefined,
            insecureTls: form.insecureTls,
          }
        : {
            argocdServer: form.serverUrl,
            argocdToken: form.token || undefined,
            argocdInsecureTls: form.insecureTls,
          };

      const res = await fetch(url, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as ArgoCDTestResult;
      if (!res.ok) throw data;
      return data;
    },
    onMutate: () => setTestResult(null),
    onSuccess: (result) => setTestResult(result),
    onError: (err: ArgoCDTestResult) =>
      setTestResult(err?.message ? err : { ok: false, message: 'Connection test failed' }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <PanelHeader title="ArgoCD Integrations" icon={CloudCog} />
        <Button size="sm" onClick={openCreate}>
          <AppIcon icon={PlusCircle} size="sm" />
          Add ArgoCD
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Connect multiple ArgoCD servers. Optionally map each instance to Kubernetes cluster names
        (comma-separated) so schedules use the correct ArgoCD for sync pause/resume.
      </p>

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-blue-500/50" />
        </div>
      ) : instances.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          No ArgoCD instances configured. Add your first integration above.
        </p>
      ) : (
        <div className="space-y-3">
          {instances.map((instance) => (
            <div
              key={instance.id}
              className="rounded-xl border border-border bg-secondary/20 px-4 py-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">{instance.name}</p>
                    <Badge variant={instance.enabled ? 'success' : 'unknown'}>
                      {instance.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{instance.serverUrl}</p>
                  {instance.clusterNames.length > 0 && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Clusters: {instance.clusterNames.join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" title="Edit" onClick={() => openEdit(instance)}>
                    <AppIcon icon={PenLine} size="sm" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Delete"
                    onClick={() => setDeleteTarget(instance)}
                  >
                    <AppIcon icon={Trash2} size="sm" className="text-red-400/70" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit ArgoCD' : 'Add ArgoCD'}</DialogTitle>
            <DialogDescription>
              Each instance needs a unique name, server URL, and API token.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Production ArgoCD"
              />
            </div>
            <div className="space-y-2">
              <Label>Server URL</Label>
              <Input
                value={form.serverUrl}
                onChange={(e) => {
                  setForm((f) => ({ ...f, serverUrl: e.target.value }));
                  setTestResult(null);
                }}
                placeholder="https://argocd.your-domain.com"
              />
            </div>
            <div className="space-y-2">
              <Label>API Token</Label>
              <Input
                type="password"
                value={form.token}
                onChange={(e) => {
                  setForm((f) => ({ ...f, token: e.target.value }));
                  setTestResult(null);
                }}
                placeholder={editing?.tokenSet ? 'Leave unchanged or enter new token' : 'Paste API token'}
              />
            </div>
            <div className="space-y-2">
              <Label>Linked cluster names (optional)</Label>
              <Input
                value={form.clusterNames}
                onChange={(e) => setForm((f) => ({ ...f, clusterNames: e.target.value }))}
                placeholder="dr-eks-cluster, prod-eks"
              />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
              <div>
                <p className="text-sm font-medium">Skip TLS verification</p>
                <p className="text-xs text-muted-foreground">For self-signed certificates</p>
              </div>
              <Switch
                checked={form.insecureTls}
                onCheckedChange={(checked) => {
                  setForm((f) => ({ ...f, insecureTls: checked }));
                  setTestResult(null);
                }}
              />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
              <div>
                <p className="text-sm font-medium">Enabled</p>
                <p className="text-xs text-muted-foreground">Disabled instances are skipped</p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(checked) => setForm((f) => ({ ...f, enabled: checked }))}
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => testMutation.mutate()}
                disabled={!form.serverUrl.trim() || testMutation.isPending}
              >
                {testMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <AppIcon icon={Bolt} />
                )}
                Test connection
              </Button>
              {testResult && (
                <div
                  className={cn(
                    'flex items-start gap-2 rounded-lg px-3 py-2 text-sm',
                    testResult.ok
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                      : 'bg-red-500/10 text-red-700 dark:text-red-400'
                  )}
                >
                  {testResult.ok ? (
                    <AppIcon icon={BadgeCheck} className="mt-0.5 shrink-0" />
                  ) : (
                    <AppIcon icon={CircleX} className="mt-0.5 shrink-0" />
                  )}
                  <p>{testResult.message}</p>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !form.name.trim() || !form.serverUrl.trim()}
            >
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {editing ? 'Save changes' : 'Add instance'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete ArgoCD instance?</DialogTitle>
            <DialogDescription>
              Remove <span className="font-medium text-foreground">{deleteTarget?.name}</span>? Schedules
              linked to this instance will fall back to other ArgoCD servers.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

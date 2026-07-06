'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileUp,
  Download,
  Globe2,
  Loader2,
  PlusCircle,
  RefreshCcw,
  ShieldCheck,
  Trash2,
} from '@/lib/icons';
import { apiFetch } from '@/lib/api-client';
import { GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  SECURITY_TOOL_CATEGORIES,
  SECURITY_TOOLS,
  securityToolsByCategory,
  type SecurityToolDefinition,
} from '@/lib/security-tools';
import { SecurityDashboardPanel } from '@/components/pod-scheduler/security-dashboard';
import { SecurityScanPanel } from '@/components/pod-scheduler/security-scan-panel';
import type {
  SecurityReportView,
  SecurityResourceView,
  SecurityToolSettingView,
} from '@/lib/security-service';
import {
  getInstallCommandsForOs,
  SERVER_OS_OPTIONS,
  type ServerOsType,
} from '@/lib/security/tool-install-specs';
import type { ToolInstallJobState } from '@/lib/security/tool-install-job';

type SecuritySection = 'resources' | 'tools' | 'scan' | 'dashboard' | 'reports';

const TOOL_INSTALL_POLL_MS = 2000;
const TOOL_INSTALL_TIMEOUT_MS = 25 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function SecurityContent() {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<SecuritySection>('resources');
  const [addOpen, setAddOpen] = useState(false);
  const [addType, setAddType] = useState<'repository' | 'target_url'>('repository');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [resourceName, setResourceName] = useState('');
  const [description, setDescription] = useState('');
  const [previewReportId, setPreviewReportId] = useState<string | null>(null);
  const [generateResourceId, setGenerateResourceId] = useState('');
  const [generateToolId, setGenerateToolId] = useState('');
  const [installDialog, setInstallDialog] = useState<{
    tool: SecurityToolDefinition;
    setting: SecurityToolSettingView;
    reinstall?: boolean;
  } | null>(null);
  const [selectedInstallOs, setSelectedInstallOs] = useState<ServerOsType | null>(null);
  const [installPhase, setInstallPhase] = useState<string | null>(null);

  useEffect(() => {
    if (!installDialog) {
      setSelectedInstallOs(null);
      return;
    }
    setSelectedInstallOs(installDialog.setting.installedOs ?? null);
  }, [installDialog]);

  const { data: resourcesData, isLoading: resourcesLoading } = useQuery({
    queryKey: ['security-resources'],
    queryFn: () => apiFetch<{ resources: SecurityResourceView[] }>('/api/security/resources'),
  });

  const { data: toolsData, isLoading: toolsLoading } = useQuery({
    queryKey: ['security-tools'],
    queryFn: () => apiFetch<{ tools: SecurityToolSettingView[] }>('/api/security/tools'),
  });

  const { data: reportsData, isLoading: reportsLoading } = useQuery({
    queryKey: ['security-reports'],
    queryFn: () => apiFetch<{ reports: SecurityReportView[] }>('/api/security/reports'),
  });

  const resources = resourcesData?.resources ?? [];
  const toolSettings = toolsData?.tools ?? [];
  const reports = reportsData?.reports ?? [];

  const enabledTools = useMemo(
    () =>
      SECURITY_TOOLS.filter(
        (tool) => toolSettings.find((row) => row.toolId === tool.id)?.enabled
      ),
    [toolSettings]
  );

  const toolEnabledMap = useMemo(
    () => new Map(toolSettings.map((row) => [row.toolId, row.enabled])),
    [toolSettings]
  );

  const toolSettingById = useMemo(
    () => new Map(toolSettings.map((row) => [row.toolId, row])),
    [toolSettings]
  );

  function handleToolToggle(tool: SecurityToolDefinition, enabled: boolean) {
    if (!enabled) {
      toggleTool.mutate({ toolId: tool.id, enabled: false });
      return;
    }

    const setting = toolSettingById.get(tool.id);
    if (!setting?.runtimeRequired) {
      toggleTool.mutate({ toolId: tool.id, enabled: true });
      return;
    }

    if (setting.runtimeReady && setting.runtimeAvailable) {
      toggleTool.mutate({ toolId: tool.id, enabled: true });
      return;
    }

    setInstallDialog({ tool, setting, reinstall: setting.runtimeReady });
  }

  const installTool = useMutation({
    mutationFn: async ({ toolId, osType }: { toolId: string; osType: ServerOsType }) => {
      setInstallPhase('Starting installation…');
      await apiFetch<ToolInstallJobState>('/api/security/tools/install', {
        method: 'POST',
        body: JSON.stringify({ toolId, osType, enableAfter: true }),
      });

      const startedAt = Date.now();
      while (true) {
        if (Date.now() - startedAt > TOOL_INSTALL_TIMEOUT_MS) {
          throw new Error(
            'Installation is still running on the server. Wait a few minutes, then refresh this page.'
          );
        }

        const job = await apiFetch<ToolInstallJobState>('/api/security/tools/install');
        setInstallPhase(job.phase);

        if (job.result) {
          return job.result;
        }
        if (job.error) {
          throw new Error(job.error);
        }
        if (!job.running) {
          throw new Error('Installation finished without a result.');
        }

        await sleep(TOOL_INSTALL_POLL_MS);
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['security-tools'], { tools: data.tools });
      setInstallDialog(null);
      setSelectedInstallOs(null);
      setInstallPhase(null);
    },
    onError: () => {
      setInstallPhase(null);
    },
  });

  const installCommandsForSelection = useMemo(() => {
    if (!installDialog || !selectedInstallOs) return [];
    return getInstallCommandsForOs(installDialog.tool.id, selectedInstallOs);
  }, [installDialog, selectedInstallOs]);

  function openAddDialog(type: 'repository' | 'target_url') {
    setAddType(type);
    setAddOpen(true);
  }

  const createResource = useMutation({
    mutationFn: () => {
      if (addType === 'repository') {
        return apiFetch('/api/security/resources', {
          method: 'POST',
          body: JSON.stringify({
            type: 'repository',
            repoUrl,
            defaultBranch: defaultBranch || undefined,
            name: resourceName || undefined,
            description: description || undefined,
          }),
        });
      }
      return apiFetch('/api/security/resources', {
        method: 'POST',
        body: JSON.stringify({
          type: 'target_url',
          targetUrl,
          name: resourceName || undefined,
          description: description || undefined,
        }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security-resources'] });
      setAddOpen(false);
      setRepoUrl('');
      setDefaultBranch('');
      setTargetUrl('');
      setResourceName('');
      setDescription('');
    },
  });

  const deleteResource = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/security/resources/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['security-resources'] }),
  });

  const cloneResource = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ resource: SecurityResourceView; message: string }>(
        `/api/security/resources/${id}/clone`,
        { method: 'POST' }
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['security-resources'] }),
  });

  const pullResource = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ resource: SecurityResourceView; message: string }>(
        `/api/security/resources/${id}/pull`,
        { method: 'POST' }
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['security-resources'] }),
  });

  const repoActionPendingId =
    cloneResource.isPending && cloneResource.variables
      ? cloneResource.variables
      : pullResource.isPending && pullResource.variables
        ? pullResource.variables
        : null;

  const toggleTool = useMutation({
    mutationFn: ({ toolId, enabled }: { toolId: string; enabled: boolean }) =>
      apiFetch('/api/security/tools', {
        method: 'PUT',
        body: JSON.stringify({ toolId, enabled }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['security-tools'] }),
  });

  const generateReport = useMutation({
    mutationFn: () =>
      apiFetch('/api/security/reports', {
        method: 'POST',
        body: JSON.stringify({ resourceId: generateResourceId, toolId: generateToolId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security-reports'] });
      queryClient.invalidateQueries({ queryKey: ['security-dashboard'] });
      setSection('reports');
    },
  });

  const { data: previewHtml, isLoading: previewLoading } = useQuery({
    queryKey: ['security-report-preview', previewReportId],
    queryFn: async () => {
      const res = await fetch(`/api/security/reports/${previewReportId}/download?format=html`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load report');
      return res.text();
    },
    enabled: Boolean(previewReportId),
  });

  const sections: { id: SecuritySection; label: string }[] = [
    { id: 'resources', label: 'Add resources' },
    { id: 'tools', label: 'Tools' },
    { id: 'scan', label: 'Scan' },
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'reports', label: 'Reports' },
  ];

  return (
    <div className="space-y-5">
      <nav
        aria-label="Security sections"
        className="inline-flex flex-wrap gap-1 rounded-xl border border-border bg-card/60 p-1"
      >
        {sections.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setSection(tab.id)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors',
              section === tab.id
                ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {section === 'resources' && (
        <GlassPanel className="flex flex-col">
          <PanelHeader
            title="Add resources"
            icon={ShieldCheck}
            accent="violet"
            action={
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1 text-[11px]"
                  onClick={() => openAddDialog('repository')}
                >
                  <PlusCircle className="h-3.5 w-3.5" />
                  Add repository
                </Button>
                <Button
                  size="sm"
                  className="h-8 gap-1 text-[11px]"
                  onClick={() => openAddDialog('target_url')}
                >
                  <PlusCircle className="h-3.5 w-3.5" />
                  Add URL target
                </Button>
              </div>
            }
          />
          <p className="border-b border-border px-5 pb-3 text-[11px] text-muted-foreground">
            Register repositories for SAST, SCA, IaC, and secrets scanning. Clone a repository here
            before running scans. Add URL targets for DAST and other scan types against live
            applications.
          </p>
          {resourcesLoading ? (
            <div className="flex justify-center p-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : !resources.length ? (
            <p className="p-10 text-center text-sm text-muted-foreground">
              No resources yet. Add a repository or URL target to get started.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table-modern w-full min-w-[860px] text-sm">
                <thead className="bg-card/95">
                  <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-5 py-3 text-left font-medium">Name</th>
                    <th className="px-5 py-3 text-left font-medium">Type</th>
                    <th className="px-5 py-3 text-left font-medium">Target</th>
                    <th className="px-5 py-3 text-left font-medium">Branch</th>
                    <th className="px-5 py-3 text-left font-medium">Clone</th>
                    <th className="px-5 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {resources.map((row) => (
                    <tr key={row.id} className="border-b border-border">
                      <td className="px-5 py-3 font-medium text-foreground">{row.name}</td>
                      <td className="px-5 py-3">
                        <Badge variant="outline" className="text-[10px]">
                          {row.type === 'target_url' ? 'URL target' : 'Repository'}
                        </Badge>
                      </td>
                      <td className="max-w-xs truncate px-5 py-3 font-mono text-xs text-muted-foreground">
                        {row.repoUrl ?? row.targetUrl ?? '—'}
                      </td>
                      <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                        {row.defaultBranch ?? '—'}
                      </td>
                      <td className="px-5 py-3 text-xs text-muted-foreground">
                        {row.type === 'repository' ? (
                          row.clone?.cloned ? (
                            <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-600">
                              Cloned
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">
                              Not cloned
                            </Badge>
                          )
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {row.type === 'repository' ? (
                            <>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 gap-1 px-2 text-[10px]"
                                disabled={Boolean(repoActionPendingId)}
                                onClick={() => cloneResource.mutate(row.id)}
                                title={row.clone?.cloned ? 'Re-clone repository' : 'Clone repository'}
                              >
                                {repoActionPendingId === row.id && cloneResource.isPending ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Download className="h-3.5 w-3.5" />
                                )}
                                Clone
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 gap-1 px-2 text-[10px]"
                                disabled={!row.clone?.cloned || Boolean(repoActionPendingId)}
                                onClick={() => pullResource.mutate(row.id)}
                                title="Pull latest changes"
                              >
                                {repoActionPendingId === row.id && pullResource.isPending ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <RefreshCcw className="h-3.5 w-3.5" />
                                )}
                                Pull
                              </Button>
                            </>
                          ) : null}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-red-600 hover:text-red-700"
                            disabled={deleteResource.isPending}
                            onClick={() => deleteResource.mutate(row.id)}
                            title="Delete resource and remove cloned files"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </GlassPanel>
      )}

      {section === 'tools' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
            <strong className="font-medium text-foreground">Live scan tools install automatically on first enable.</strong>{' '}
            Semgrep, npm audit, and Gitleaks install on the SecureNexus server when you click Install
            &amp; enable — no manual terminal steps. Other tools use sample reports until integrated.
          </div>
          {toolsLoading ? (
            <div className="flex justify-center p-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            SECURITY_TOOL_CATEGORIES.map((category) => {
              const tools = securityToolsByCategory(category.id);
              return (
                <GlassPanel key={category.id} className="p-5">
                  <div className="mb-4">
                    <h3 className="text-sm font-semibold text-foreground">{category.label}</h3>
                    <p className="text-[11px] text-muted-foreground">{category.description}</p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {tools.map((tool) => (
                      <ToolCard
                        key={tool.id}
                        tool={tool}
                        setting={toolSettingById.get(tool.id)}
                        enabled={toolEnabledMap.get(tool.id) ?? false}
                        pending={toggleTool.isPending || installTool.isPending}
                        onToggle={(enabled) => handleToolToggle(tool, enabled)}
                      />
                    ))}
                  </div>
                </GlassPanel>
              );
            })
          )}
        </div>
      )}

      {section === 'scan' && (
        <SecurityScanPanel
          resources={resources}
          toolSettings={toolSettings}
          loading={resourcesLoading || toolsLoading}
        />
      )}

      {section === 'dashboard' && <SecurityDashboardPanel />}

      {section === 'reports' && (
        <GlassPanel className="flex flex-col">
          <PanelHeader title="Reports" icon={FileUp} accent="sky" />
          <div className="border-b border-border px-5 py-4">
            <p className="mb-3 text-[11px] text-muted-foreground">
              Generate assessment reports for enabled tools and registered resources. Download as HTML or PDF.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[180px] flex-1 space-y-1.5">
                <Label className="text-[11px]">Resource</Label>
                <Select value={generateResourceId} onValueChange={setGenerateResourceId}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select resource" />
                  </SelectTrigger>
                  <SelectContent>
                    {resources.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {row.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-[180px] flex-1 space-y-1.5">
                <Label className="text-[11px]">Tool</Label>
                <Select value={generateToolId} onValueChange={setGenerateToolId}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select enabled tool" />
                  </SelectTrigger>
                  <SelectContent>
                    {enabledTools.map((tool) => (
                      <SelectItem key={tool.id} value={tool.id}>
                        {tool.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                size="sm"
                className="h-9"
                disabled={!generateResourceId || !generateToolId || generateReport.isPending}
                onClick={() => generateReport.mutate()}
              >
                {generateReport.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  'Generate report'
                )}
              </Button>
            </div>
          </div>

          {reportsLoading ? (
            <div className="flex justify-center p-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : !reports.length ? (
            <p className="p-10 text-center text-sm text-muted-foreground">
              No reports yet. Enable tools, add a resource, then generate a report.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table-modern w-full min-w-[760px] text-sm">
                <thead className="bg-card/95">
                  <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-5 py-3 text-left font-medium">Report</th>
                    <th className="px-5 py-3 text-left font-medium">Tool</th>
                    <th className="px-5 py-3 text-left font-medium">Resource</th>
                    <th className="px-5 py-3 text-left font-medium">Created</th>
                    <th className="px-5 py-3 text-right font-medium">Download</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((row) => (
                    <tr key={row.id} className="border-b border-border">
                      <td className="px-5 py-3 font-medium text-foreground">{row.title}</td>
                      <td className="px-5 py-3 text-muted-foreground">{row.toolName}</td>
                      <td className="px-5 py-3 text-muted-foreground">{row.resourceName ?? '—'}</td>
                      <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 text-[11px]"
                            onClick={() => setPreviewReportId(row.id)}
                          >
                            HTML
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1 text-[11px]"
                            asChild
                          >
                            <a href={`/api/security/reports/${row.id}/download?format=html`}>
                              <FileUp className="h-3 w-3" />
                              .html
                            </a>
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1 text-[11px]"
                            asChild
                          >
                            <a href={`/api/security/reports/${row.id}/download?format=pdf`}>
                              <FileUp className="h-3 w-3" />
                              .pdf
                            </a>
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </GlassPanel>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {addType === 'target_url' ? 'Add URL target' : 'Add repository'}
            </DialogTitle>
            <DialogDescription>
              {addType === 'target_url'
                ? 'Register a live application URL for DAST and other dynamic security scans.'
                : 'Register a source repository for SAST, SCA, IaC, and secrets scanning.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label>Resource type</Label>
              <Select value={addType} onValueChange={(v) => setAddType(v as typeof addType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="repository">Repository</SelectItem>
                  <SelectItem value="target_url">URL target</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Display name (optional)</Label>
              <Input value={resourceName} onChange={(e) => setResourceName(e.target.value)} />
            </div>
            {addType === 'repository' ? (
              <>
                <div className="space-y-2">
                  <Label>Repository URL</Label>
                  <Input
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    placeholder="https://bitbucket.org/workspace/repo"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Branch (optional)</Label>
                  <Input
                    value={defaultBranch}
                    onChange={(e) => setDefaultBranch(e.target.value)}
                    placeholder="main"
                  />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label>URL target</Label>
                <Input
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://app.example.com"
                />
                <p className="text-[10px] text-muted-foreground">
                  Used primarily for DAST; other scan types can be selected when running a scan.
                </p>
              </div>
            )}
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createResource.mutate()}
              disabled={
                createResource.isPending ||
                (addType === 'repository' ? !repoUrl.trim() : !targetUrl.trim())
              }
            >
              {createResource.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(installDialog)} onOpenChange={(open) => !open && !installTool.isPending && setInstallDialog(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {installDialog?.reinstall ? 'Reinstall' : 'Install'} {installDialog?.tool.name}?
            </DialogTitle>
            <DialogDescription>
              {installDialog?.reinstall
                ? `${installDialog.tool.name} was installed before but is not available on this server now. Select the server OS and reinstall.`
                : `${installDialog?.tool.name} requires a one-time install on the SecureNexus server. Select the server operating system first.`}
            </DialogDescription>
          </DialogHeader>
          {installDialog ? (
            <div className="space-y-4 text-[11px] text-muted-foreground">
              {!selectedInstallOs ? (
                <div className="space-y-2">
                  <p className="font-medium text-foreground">1. Select server OS</p>
                  <div className="grid gap-2">
                    {SERVER_OS_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        disabled={installTool.isPending}
                        onClick={() => setSelectedInstallOs(option.id)}
                        className="rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/5"
                      >
                        <span className="block text-sm font-medium text-foreground">{option.label}</span>
                        <span className="block text-[10px] text-muted-foreground">{option.description}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-foreground">
                      2. Install on{' '}
                      {SERVER_OS_OPTIONS.find((row) => row.id === selectedInstallOs)?.label}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[10px]"
                      disabled={installTool.isPending}
                      onClick={() => setSelectedInstallOs(null)}
                    >
                      Change OS
                    </Button>
                  </div>
                  <p>
                    SecureNexus installs {installDialog.tool.name} automatically when you click{' '}
                    <span className="font-medium text-foreground">Install &amp; enable</span>. You do
                    not need to run any commands manually.
                  </p>
                  <div className="rounded-lg border border-border bg-muted/30 p-3 text-[10px] text-foreground">
                    <p className="mb-2 font-medium">What happens automatically:</p>
                    <ul className="list-inside list-disc space-y-1 text-muted-foreground">
                      {installCommandsForSelection.map((command) => (
                        <li key={command}>{command}</li>
                      ))}
                    </ul>
                  </div>
                  {installDialog.setting.runtimeAvailable ? (
                    <p className="text-emerald-600">
                      This tool appears to be available already. Click install to verify and enable
                      it.
                    </p>
                  ) : null}
                  {installTool.isPending && installPhase ? (
                    <p className="text-foreground">{installPhase}</p>
                  ) : null}
                  {installTool.isError ? (
                    <p className="text-red-600">
                      {installTool.error instanceof Error
                        ? installTool.error.message
                        : 'Installation failed'}
                    </p>
                  ) : null}
                  {installTool.isSuccess ? (
                    <p className="text-emerald-600">{installTool.data.message}</p>
                  ) : null}
                  {installTool.isPending ? (
                    <p className="text-muted-foreground">
                      This can take several minutes the first time. The dialog will stay open until
                      installation completes.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={installTool.isPending}
              onClick={() => setInstallDialog(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={installTool.isPending || !installDialog || !selectedInstallOs}
              onClick={() =>
                installDialog &&
                selectedInstallOs &&
                installTool.mutate({ toolId: installDialog.tool.id, osType: selectedInstallOs })
              }
            >
              {installTool.isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  Installing…
                </>
              ) : (
                `${installDialog?.reinstall ? 'Reinstall' : 'Install'} & enable`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(previewReportId)} onOpenChange={(open) => !open && setPreviewReportId(null)}>
        <DialogContent className="flex h-[92vh] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
            <DialogTitle>Report preview</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden bg-muted/30 p-3">
            {previewLoading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <iframe
                title="Security report preview"
                srcDoc={previewHtml ?? ''}
                className="h-full w-full rounded-lg border border-border bg-white"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ToolCard({
  tool,
  setting,
  enabled,
  pending,
  onToggle,
}: {
  tool: SecurityToolDefinition;
  setting?: SecurityToolSettingView;
  enabled: boolean;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border border-border bg-card/80 p-3 transition-colors',
        enabled && 'border-emerald-500/30 bg-emerald-500/5'
      )}
    >
      <div
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xs font-bold text-white shadow-sm"
        style={{ backgroundColor: tool.color }}
        title={tool.name}
      >
        {tool.initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-medium text-foreground">{tool.name}</p>
            <p className="line-clamp-2 text-[10px] leading-relaxed text-muted-foreground">
              {tool.description}
            </p>
          </div>
          <Switch checked={enabled} disabled={pending} onCheckedChange={onToggle} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-[9px]">
            Open source
          </Badge>
          {setting?.runtimeRequired ? (
            setting.runtimeReady ? (
              <Badge
                variant="outline"
                className={cn(
                  'text-[9px]',
                  setting.runtimeAvailable
                    ? 'border-emerald-500/40 text-emerald-600'
                    : 'border-amber-500/40 text-amber-600'
                )}
              >
                {setting.runtimeAvailable ? 'Installed' : 'Needs reinstall'}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[9px] text-muted-foreground">
                Install on enable
              </Badge>
            )
          ) : null}
          <a
            href={tool.website}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-[10px] text-blue-600 hover:underline dark:text-blue-400"
          >
            Website
            <Globe2 className="h-2.5 w-2.5" />
          </a>
        </div>
      </div>
    </div>
  );
}

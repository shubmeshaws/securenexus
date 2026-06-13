'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, CloudCog, FileUp, FolderOpen, Loader2 } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { apiFetch } from '@/lib/api-client';
import { cn } from '@/lib/utils';

type Provider = 'kubeconfig' | 'aws';

interface KubeconfigContextOption {
  name: string;
  cluster: string;
  server: string | null;
  user: string | null;
  isCurrent: boolean;
  alreadyAdded: boolean;
  registeredName: string | null;
}

interface KubeconfigPreview {
  resolvedPath: string;
  contexts: KubeconfigContextOption[];
  currentContext: string | null;
}

interface AddClusterDialogProps {
  open: boolean;
  onClose: () => void;
}

function normalizeKubeconfigPreview(data: {
  resolvedPath: string;
  currentContext: string | null;
  contexts?: unknown;
}): KubeconfigPreview {
  const rawContexts = Array.isArray(data.contexts) ? data.contexts : [];

  const contexts: KubeconfigContextOption[] = rawContexts.map((item: unknown, index) => {
    if (typeof item === 'string') {
      return {
        name: item,
        cluster: item,
        server: null,
        user: null,
        isCurrent: item === data.currentContext,
        alreadyAdded: false,
        registeredName: null,
      };
    }

    const ctx = item as Partial<KubeconfigContextOption>;
    const name = ctx.name?.trim() || `context-${index + 1}`;
    return {
      name,
      cluster: ctx.cluster?.trim() || name,
      server: ctx.server ?? null,
      user: ctx.user ?? null,
      isCurrent: Boolean(ctx.isCurrent ?? name === data.currentContext),
      alreadyAdded: Boolean(ctx.alreadyAdded),
      registeredName: ctx.registeredName ?? null,
    };
  });

  const seen = new Set<string>();
  const uniqueContexts = contexts.map((ctx, index) => {
    let uniqueName = ctx.name;
    if (!uniqueName || seen.has(uniqueName)) {
      uniqueName = `${ctx.name || 'context'}-${index + 1}`;
    }
    seen.add(uniqueName);
    return uniqueName === ctx.name ? ctx : { ...ctx, name: uniqueName };
  });

  return {
    resolvedPath: data.resolvedPath,
    currentContext: data.currentContext,
    contexts: uniqueContexts,
  };
}

export function AddClusterDialog({ open, onClose }: AddClusterDialogProps) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<Provider>('kubeconfig');
  const [name, setName] = useState('');
  const [contextName, setContextName] = useState('');
  const [selectedContext, setSelectedContext] = useState<string | null>(null);
  const [kubeconfigPath, setKubeconfigPath] = useState('~/.kube/config');
  const [kubeconfigFile, setKubeconfigFile] = useState<string>('');
  const [fileName, setFileName] = useState('');
  const [pathPreview, setPathPreview] = useState<KubeconfigPreview | null>(null);
  const [pathError, setPathError] = useState('');
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('');
  const [awsSecretKey, setAwsSecretKey] = useState('');
  const [awsRegion, setAwsRegion] = useState('us-east-1');
  const [awsClusterName, setAwsClusterName] = useState('');

  const contexts = pathPreview?.contexts ?? [];
  const selectedOption = contexts.find((ctx) => ctx.name === selectedContext) ?? null;
  const selectedAlreadyAdded = Boolean(selectedOption?.alreadyAdded);

  const loadPathMutation = useMutation({
    mutationFn: (path: string) =>
      apiFetch<KubeconfigPreview>('/api/clusters/registry/read-kubeconfig', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    onSuccess: (data) => {
      const preview = normalizeKubeconfigPreview(data);
      setPathPreview(preview);
      setPathError('');
      setSelectedContext(null);
      setName('');
      setContextName('');

      const defaultCtx =
        preview.contexts.find((ctx) => ctx.isCurrent && !ctx.alreadyAdded) ??
        preview.contexts.find((ctx) => !ctx.alreadyAdded);

      if (defaultCtx) {
        setSelectedContext(defaultCtx.name);
        setContextName(defaultCtx.name);
        setName(defaultCtx.name);
      }
    },
    onError: (err) => {
      setPathPreview(null);
      setSelectedContext(null);
      setPathError(err instanceof Error ? err.message : 'Failed to load kubeconfig');
    },
  });

  const mutation = useMutation({
    mutationFn: () => {
      const body =
        provider === 'kubeconfig'
          ? {
              name,
              provider,
              contextName: contextName || name,
              ...(kubeconfigFile
                ? { kubeconfigB64: kubeconfigFile }
                : { kubeconfigPath }),
            }
          : {
              name,
              provider,
              awsAccessKeyId,
              awsSecretKey,
              awsRegion,
              awsClusterName,
            };
      return apiFetch('/api/clusters/registry', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['registered-clusters'] });
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      resetForm();
      onClose();
    },
  });

  function selectContext(ctx: KubeconfigContextOption) {
    setSelectedContext(ctx.name);
    setContextName(ctx.name);
    setName(ctx.name);
  }

  function resetForm() {
    setName('');
    setContextName('');
    setSelectedContext(null);
    setKubeconfigPath('~/.kube/config');
    setKubeconfigFile('');
    setFileName('');
    setPathPreview(null);
    setPathError('');
    setAwsAccessKeyId('');
    setAwsSecretKey('');
    setAwsRegion('us-east-1');
    setAwsClusterName('');
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setPathPreview(null);
    setSelectedContext(null);
    setPathError('');
    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result as string;
      setKubeconfigFile(btoa(content));
      if (!name) setName(file.name.replace(/\.(yaml|yml|conf)$/i, ''));
    };
    reader.readAsText(file);
  }

  function handlePathChange(value: string) {
    setKubeconfigPath(value);
    setPathPreview(null);
    setSelectedContext(null);
    setPathError('');
    if (kubeconfigFile) {
      setKubeconfigFile('');
      setFileName('');
    }
  }

  const usingPathSource = Boolean(pathPreview && !kubeconfigFile);
  const pathFlowReady = usingPathSource && Boolean(selectedContext) && !selectedAlreadyAdded;
  const selectValue =
    selectedContext && selectedOption && !selectedOption.alreadyAdded
      ? selectedContext
      : undefined;

  function formatContextLabel(ctx: KubeconfigContextOption) {
    const tags = [
      ctx.isCurrent ? 'Current' : null,
      ctx.alreadyAdded ? 'Already added' : null,
    ].filter(Boolean);
    return tags.length > 0 ? `${ctx.name} (${tags.join(', ')})` : ctx.name;
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[min(90vh,640px)] max-w-lg flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 space-y-1.5 px-6 pt-6">
          <DialogTitle>Add Cluster</DialogTitle>
          <DialogDescription>
            Connect a Kubernetes cluster using a local kubeconfig path, uploaded file, or AWS credentials (EKS).
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-4">
        <div className="flex min-w-0 gap-1.5 rounded-xl border border-border bg-secondary/50 p-1">
          {(['kubeconfig', 'aws'] as Provider[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setProvider(p)}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 rounded-lg py-2.5 text-xs font-medium transition-all duration-200',
                provider === p
                  ? 'bg-blue-500/15 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200 shadow-glow-sm'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              {p === 'kubeconfig' ? (
                <AppIcon icon={FileUp} size="sm" />
              ) : (
                <AppIcon icon={CloudCog} size="sm" />
              )}
              {p === 'kubeconfig' ? 'Kubeconfig File' : 'AWS Credentials'}
            </button>
          ))}
        </div>

        <div className="mt-4 min-w-0 space-y-4">
          {provider === 'kubeconfig' ? (
            <>
              <div className="min-w-0 space-y-2">
                <Label>Local Kubeconfig Path</Label>
                <div className="flex min-w-0 gap-2">
                  <Input
                    value={kubeconfigPath}
                    onChange={(e) => handlePathChange(e.target.value)}
                    placeholder="~/.kube/config"
                    className="min-w-0 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    disabled={!kubeconfigPath.trim() || loadPathMutation.isPending}
                    onClick={() => loadPathMutation.mutate(kubeconfigPath)}
                  >
                    {loadPathMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <AppIcon icon={FolderOpen} />
                        <span className="ml-1.5 hidden sm:inline">Fetch</span>
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Path is read on the server where SecureNexus runs. Must be under your home directory.
                </p>
                {pathError && <p className="text-xs text-red-400">{pathError}</p>}
                {pathPreview && (
                  <div className="flex min-w-0 items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                    <AppIcon icon={BadgeCheck} size="sm" className="mt-0.5 shrink-0" />
                    <p className="min-w-0 break-all">
                      Loaded <span className="font-mono">{pathPreview.resolvedPath}</span>
                      {' — '}{contexts.length} cluster{contexts.length !== 1 ? 's' : ''} found
                    </p>
                  </div>
                )}
              </div>

              {pathPreview && contexts.length > 0 && (
                <div className="min-w-0 space-y-2">
                  <Label>Select Cluster</Label>
                  <Select
                    value={selectValue}
                    onValueChange={(value) => {
                      const ctx = contexts.find((c) => c.name === value);
                      if (ctx && !ctx.alreadyAdded) selectContext(ctx);
                    }}
                  >
                    <SelectTrigger className="h-10 w-full min-w-0">
                      <SelectValue placeholder="Choose a cluster context" />
                    </SelectTrigger>
                    <SelectContent
                      position="popper"
                      sideOffset={4}
                      className="z-[200] w-[var(--radix-select-trigger-width)]"
                    >
                      {contexts.map((ctx, index) => (
                        <SelectItem
                          key={`${ctx.name}-${index}`}
                          value={ctx.name}
                          textValue={formatContextLabel(ctx)}
                          disabled={ctx.alreadyAdded}
                        >
                          {formatContextLabel(ctx)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedOption && (
                    <div className="min-w-0 rounded-lg border border-border bg-secondary/40 px-3 py-2">
                      <p className="truncate text-xs font-medium text-foreground">{selectedOption.name}</p>
                      {selectedOption.server && (
                        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                          {selectedOption.server}
                        </p>
                      )}
                    </div>
                  )}
                  {selectedAlreadyAdded && (
                    <p className="text-xs text-amber-600 dark:text-amber-300">
                      This cluster is already in your registry. Select a different context to add another.
                    </p>
                  )}
                </div>
              )}

              {(pathFlowReady || kubeconfigFile || (pathPreview && selectedContext)) && (
                <div className="space-y-2">
                  <Label>Cluster Name</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="production-us-east"
                    disabled={selectedAlreadyAdded}
                    required
                  />
                  {selectedContext && (
                    <p className="text-[11px] text-muted-foreground">
                      Context: <span className="font-mono text-foreground">{selectedContext}</span>
                    </p>
                  )}
                </div>
              )}

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-[10px] uppercase tracking-wide">
                  <span className="bg-background px-2 text-muted-foreground">or upload</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Upload Kubeconfig</Label>
                <label className="group flex h-24 w-full cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-border transition-all duration-200 hover:border-blue-500/30 hover:bg-blue-500/5">
                  <AppIcon
                    icon={FileUp}
                    size="lg"
                    className="mb-1.5 text-muted-foreground transition-colors group-hover:text-blue-500 dark:group-hover:text-blue-400"
                  />
                  <span className="text-xs text-muted-foreground group-hover:text-foreground">
                    {fileName || 'Drop kubeconfig or click to browse'}
                  </span>
                  <input type="file" accept=".yaml,.yml,.conf" className="hidden" onChange={handleFileChange} />
                </label>
              </div>

              {kubeconfigFile && !pathPreview && (
                <div className="space-y-2">
                  <Label>Cluster Name</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="production-us-east"
                    required
                  />
                  <div className="space-y-2">
                    <Label>Context Name (optional)</Label>
                    <Input
                      value={contextName}
                      onChange={(e) => setContextName(e.target.value)}
                      placeholder="Leave blank to use cluster name"
                    />
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Cluster Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="production-us-east"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>EKS Cluster Name</Label>
                <Input
                  value={awsClusterName}
                  onChange={(e) => setAwsClusterName(e.target.value)}
                  placeholder="my-eks-cluster"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>AWS Region</Label>
                <Select value={awsRegion} onValueChange={setAwsRegion}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['us-east-1', 'us-west-2', 'eu-west-1', 'ap-south-1', 'ap-southeast-1'].map((r) => (
                      <SelectItem key={r} value={r}>{r}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>AWS Access Key ID</Label>
                <Input
                  value={awsAccessKeyId}
                  onChange={(e) => setAwsAccessKeyId(e.target.value)}
                  placeholder="AKIA..."
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label>AWS Secret Access Key</Label>
                <Input
                  type="password"
                  value={awsSecretKey}
                  onChange={(e) => setAwsSecretKey(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </div>
            </>
          )}
        </div>
        </div>

        {mutation.isError && (
          <p className="shrink-0 px-6 text-xs text-red-400">
            {mutation.error instanceof Error ? mutation.error.message : 'Failed to add cluster'}
          </p>
        )}

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={
              mutation.isPending ||
              (provider === 'kubeconfig'
                ? kubeconfigFile
                  ? !name
                  : !pathFlowReady || !name || selectedAlreadyAdded
                : !name || !awsAccessKeyId || !awsSecretKey || !awsClusterName)
            }
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add Cluster'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

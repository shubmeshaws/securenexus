'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Bolt, CircleX, Copy, FileJson, Loader2, PenLine, PlusCircle, Trash2 } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch } from '@/lib/api-client';
import { TECH_ICONS } from '@/lib/tech-icons';
import { PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { ConfirmDialog } from '@/components/pod-scheduler/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

const SECRET_PLACEHOLDER = '••••••••';
const DEFAULT_AWS_REGION = 'ap-south-1';

const AWS_REGIONS = [
  'ap-south-1',
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-central-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
];

function statusBannerClass(ok: boolean) {
  return ok
    ? 'border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-500/40 dark:bg-emerald-950/50 dark:text-emerald-100'
    : 'border-red-200 bg-red-50 text-red-950 dark:border-red-500/40 dark:bg-red-950/50 dark:text-red-100';
}

function statusIconClass(ok: boolean) {
  return ok
    ? 'text-emerald-700 dark:text-emerald-300'
    : 'text-red-700 dark:text-red-300';
}

interface AwsCredential {
  id: string;
  name: string;
  accessKeyId: string;
  secretAccessKeySet: boolean;
  defaultRegion: string;
  awsAccountId: string | null;
  iamUsername: string | null;
  iamRoleName: string | null;
}

interface AwsTestResult {
  ok: boolean;
  message: string;
}

interface IamPolicyResponse {
  policyJson: string;
  notes: string[];
}

interface CredentialFormState {
  name: string;
  accessKeyId: string;
  secretAccessKey: string;
  defaultRegion: string;
  iamRoleName: string;
}

const emptyForm = (): CredentialFormState => ({
  name: '',
  accessKeyId: '',
  secretAccessKey: '',
  defaultRegion: DEFAULT_AWS_REGION,
  iamRoleName: '',
});

export function AwsCredentialsPanel() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['aws-credentials'],
    queryFn: () => apiFetch<{ credentials: AwsCredential[] }>('/api/admin/aws-credentials'),
    retry: false,
  });

  const credentials = data?.credentials ?? [];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<CredentialFormState>(emptyForm);
  const [testResult, setTestResult] = useState<AwsTestResult | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyData, setPolicyData] = useState<IamPolicyResponse | null>(null);
  const [policyCredId, setPolicyCredId] = useState<string | null>(null);
  const [copyOk, setCopyOk] = useState(false);

  const editing = credentials.find((c) => c.id === editingId) ?? null;
  const isEdit = Boolean(editingId);

  useEffect(() => {
    if (!formOpen) return;
    if (editing) {
      setForm({
        name: editing.name,
        accessKeyId: editing.accessKeyId,
        secretAccessKey: editing.secretAccessKeySet ? SECRET_PLACEHOLDER : '',
        defaultRegion: editing.defaultRegion || DEFAULT_AWS_REGION,
        iamRoleName: editing.iamRoleName ?? '',
      });
    } else {
      setForm(emptyForm());
    }
    setTestResult(null);
    setSaveFeedback(null);
  }, [formOpen, editing]);

  const regionOptions = Array.from(
    new Set(
      [...AWS_REGIONS, form.defaultRegion].filter((region): region is string => Boolean(region))
    )
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        accessKeyId: form.accessKeyId.trim(),
        secretAccessKey:
          form.secretAccessKey && form.secretAccessKey !== SECRET_PLACEHOLDER
            ? form.secretAccessKey
            : undefined,
        defaultRegion: form.defaultRegion,
        iamRoleName: form.iamRoleName.trim() || null,
      };

      if (isEdit && editingId) {
        return apiFetch<{ credential: AwsCredential }>(
          `/api/admin/aws-credentials/${editingId}`,
          { method: 'PATCH', body: JSON.stringify(payload) }
        );
      }
      return apiFetch<{ credential: AwsCredential }>('/api/admin/aws-credentials', {
        method: 'POST',
        body: JSON.stringify({ ...payload, secretAccessKey: form.secretAccessKey }),
      });
    },
    onMutate: () => {
      setSaveFeedback(null);
      setTestResult(null);
    },
    onSuccess: () => {
      setSaveFeedback({ ok: true, message: isEdit ? 'AWS account updated' : 'AWS account saved' });
      setFormOpen(false);
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ['aws-credentials'] });
      queryClient.invalidateQueries({ queryKey: ['aws-settings'] });
    },
    onError: (err: Error) => {
      setSaveFeedback({ ok: false, message: err.message || 'Failed to save' });
    },
  });

  const testMutation = useMutation({
    mutationFn: () => {
      const body = {
        accessKeyId: form.accessKeyId,
        secretAccessKey: form.secretAccessKey,
        defaultRegion: form.defaultRegion,
        iamRoleName: form.iamRoleName.trim() || null,
        name: form.name.trim() || undefined,
      };
      if (isEdit && editingId) {
        return apiFetch<AwsTestResult>(`/api/admin/aws-credentials/${editingId}/test`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      return apiFetch<AwsTestResult>('/api/admin/settings/aws/test', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onMutate: () => {
      setTestResult(null);
      setSaveFeedback(null);
    },
    onSuccess: (result) => setTestResult(result),
    onError: (err: Error) => setTestResult({ ok: false, message: err.message }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/admin/aws-credentials/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setRemoveId(null);
      queryClient.invalidateQueries({ queryKey: ['aws-credentials'] });
      queryClient.invalidateQueries({ queryKey: ['aws-settings'] });
    },
  });

  const policyMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<IamPolicyResponse>(`/api/admin/aws-credentials/${id}/iam-policy`),
    onSuccess: (result, id) => {
      setPolicyData(result);
      setPolicyCredId(id);
      setPolicyOpen(true);
      setCopyOk(false);
    },
  });

  async function copyPolicy() {
    if (!policyData?.policyJson) return;
    await navigator.clipboard.writeText(policyData.policyJson);
    setCopyOk(true);
    setTimeout(() => setCopyOk(false), 2000);
  }

  function openAdd() {
    setEditingId(null);
    setFormOpen(true);
  }

  function openEdit(id: string) {
    setEditingId(id);
    setFormOpen(true);
  }

  const canSave =
    form.name.trim() &&
    form.accessKeyId.trim() &&
    (isEdit
      ? editing?.secretAccessKeySet || (form.secretAccessKey && form.secretAccessKey !== SECRET_PLACEHOLDER)
      : Boolean(form.secretAccessKey.trim()));

  const canTest =
    form.accessKeyId.trim() &&
    (isEdit
      ? editing?.secretAccessKeySet || Boolean(form.secretAccessKey.trim())
      : Boolean(form.secretAccessKey.trim()));

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-blue-500/50" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <PanelHeader
          title="AWS Integration"
          brandIconSrc={TECH_ICONS.aws}
          brandIconAlt="AWS"
          brandIconSurface="light"
          accent="amber"
        />
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-950 dark:border-red-500/40 dark:bg-red-950/50 dark:text-red-100">
          Failed to load AWS accounts: {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <PanelHeader
          title="AWS Integration"
          brandIconSrc={TECH_ICONS.aws}
          brandIconAlt="AWS"
          brandIconSurface="light"
          accent="amber"
        />
        <p className="text-[11px] text-muted-foreground">
          Save multiple named AWS accounts for EKS cluster registration, EC2 scheduling, and API
          calls. Credentials are encrypted at rest.
        </p>

        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Saved accounts</p>
          <Button size="sm" variant="outline" onClick={openAdd}>
            <AppIcon icon={PlusCircle} size="sm" />
            Add account
          </Button>
        </div>

        {credentials.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
            No AWS accounts configured yet. Add one to enable EKS and Non-EKS schedules.
          </div>
        ) : (
          <div className="space-y-2">
            {credentials.map((cred) => (
              <div
                key={cred.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-secondary/10 px-4 py-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{cred.name}</p>
                    <Badge variant="success">Configured</Badge>
                  </div>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {cred.awsAccountId ? `Account ${cred.awsAccountId}` : 'Account pending save/test'}
                    {cred.iamUsername ? ` · ${cred.iamUsername}` : ''}
                    {cred.iamRoleName ? ` · role ${cred.iamRoleName}` : ''}
                    {` · ${cred.defaultRegion} · ${cred.accessKeyId}`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => openEdit(cred.id)}>
                    <AppIcon icon={PenLine} size="sm" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => policyMutation.mutate(cred.id)}
                    disabled={policyMutation.isPending}
                  >
                    <AppIcon icon={FileJson} size="sm" />
                    IAM policy
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-red-500/30 text-red-700 hover:bg-red-500/10 dark:text-red-400"
                    onClick={() => setRemoveId(cred.id)}
                  >
                    <AppIcon icon={Trash2} size="sm" />
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit AWS account' : 'Add AWS account'}</DialogTitle>
            <DialogDescription>
              Give this account a name you will recognize in schedules (e.g. Production, Staging).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Account name</Label>
              <Input
                value={form.name}
                onChange={(e) => {
                  setForm((f) => ({ ...f, name: e.target.value }));
                  setTestResult(null);
                  setSaveFeedback(null);
                }}
                placeholder="Production"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label>Access key ID</Label>
              <Input
                value={form.accessKeyId}
                onChange={(e) => {
                  setForm((f) => ({ ...f, accessKeyId: e.target.value }));
                  setTestResult(null);
                  setSaveFeedback(null);
                }}
                placeholder="AKIA..."
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label>Secret access key</Label>
              <Input
                type="password"
                value={form.secretAccessKey}
                onChange={(e) => {
                  setForm((f) => ({ ...f, secretAccessKey: e.target.value }));
                  setTestResult(null);
                  setSaveFeedback(null);
                }}
                placeholder={
                  isEdit && editing?.secretAccessKeySet
                    ? 'Leave unchanged or enter new secret'
                    : 'Paste secret access key'
                }
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-2">
              <Label>Default region</Label>
              <Select
                value={form.defaultRegion}
                onValueChange={(value) => {
                  setForm((f) => ({ ...f, defaultRegion: value }));
                  setTestResult(null);
                  setSaveFeedback(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {regionOptions.map((region) => (
                    <SelectItem key={region} value={region}>
                      {region}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>IAM role (optional)</Label>
              <Input
                value={form.iamRoleName}
                onChange={(e) => {
                  setForm((f) => ({ ...f, iamRoleName: e.target.value }));
                  setTestResult(null);
                  setSaveFeedback(null);
                }}
                placeholder="SecureNexusRole or full role ARN"
                autoComplete="off"
              />
              <p className="text-[10px] text-muted-foreground">
                When set, SecureNexus assumes this role for EC2/EKS API calls. Use if the access
                keys only have permission to assume a role with the real permissions.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending || !canTest}
              >
                {testMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <AppIcon icon={Bolt} size="sm" />
                )}
                Test connection
              </Button>
              <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !canSave}>
                {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {isEdit ? 'Save changes' : 'Save account'}
              </Button>
            </div>

            {testResult && (
              <div
                className={cn(
                  'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs leading-relaxed',
                  statusBannerClass(testResult.ok)
                )}
              >
                <AppIcon
                  icon={testResult.ok ? BadgeCheck : CircleX}
                  size="sm"
                  className={cn('mt-0.5 shrink-0', statusIconClass(testResult.ok))}
                />
                <span className="font-medium break-all">{testResult.message}</span>
              </div>
            )}

            {saveFeedback && (
              <div
                className={cn(
                  'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs leading-relaxed',
                  statusBannerClass(saveFeedback.ok)
                )}
              >
                <AppIcon
                  icon={saveFeedback.ok ? BadgeCheck : CircleX}
                  size="sm"
                  className={cn('mt-0.5 shrink-0', statusIconClass(saveFeedback.ok))}
                />
                <span className="font-medium">{saveFeedback.message}</span>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(removeId)}
        onOpenChange={(open) => !open && setRemoveId(null)}
        title="Remove AWS account?"
        description="This removes the saved credentials from SecureNexus. Schedules using this account will fail until updated."
        confirmLabel="Remove account"
        onConfirm={() => removeId && removeMutation.mutate(removeId)}
        loading={removeMutation.isPending}
      />

      <Dialog open={policyOpen} onOpenChange={setPolicyOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>SecureNexus IAM policy</DialogTitle>
            <DialogDescription>
              Attach this inline policy to the IAM user for{' '}
              {credentials.find((c) => c.id === policyCredId)?.name ?? 'this account'}.
            </DialogDescription>
          </DialogHeader>
          {policyData && (
            <div className="space-y-3">
              <ul className="list-disc space-y-1 pl-4 text-[11px] text-muted-foreground">
                {(policyData.notes ?? []).map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
              <pre className="max-h-[320px] overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-[11px] text-foreground">
                {policyData.policyJson}
              </pre>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPolicyOpen(false)}>
              Close
            </Button>
            <Button onClick={copyPolicy} disabled={!policyData}>
              <AppIcon icon={Copy} size="sm" />
              {copyOk ? 'Copied' : 'Copy policy JSON'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

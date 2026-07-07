'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SecurityIconButton } from '@/components/pod-scheduler/security-icon-button';
import { Trash2 } from '@/lib/icons';
import { cn, formatNextRunAt } from '@/lib/utils';
import type {
  SecurityAutomationRunStatus,
  SecurityAutomationView,
} from '@/lib/security-automation-service';
import type { SecurityResourceView } from '@/lib/security-service';
import { SECURITY_TOOL_CATEGORIES, SECURITY_TOOLS } from '@/lib/security-tools';

function runStatusLabel(status: SecurityAutomationRunStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'disabled':
      return 'Disabled';
    default:
      return 'Idle';
  }
}

function runStatusBadgeVariant(status: SecurityAutomationRunStatus) {
  if (status === 'running') return 'progressing' as const;
  if (status === 'completed') return 'success' as const;
  if (status === 'failed') return 'failed' as const;
  if (status === 'disabled') return 'outline' as const;
  return 'manual' as const;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 border-t border-border px-1 py-2 text-xs first:border-t-0">
      <span className="font-medium text-muted-foreground">{label}</span>
      <span className="whitespace-pre-wrap break-words text-foreground">{value}</span>
    </div>
  );
}

function AutomationDetailDialog({
  automation,
  resources,
  open,
  onOpenChange,
  onEdit,
}: {
  automation: SecurityAutomationView | null;
  resources: SecurityResourceView[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: (automation: SecurityAutomationView) => void;
}) {
  const resourceNames = useMemo(() => {
    if (!automation) return [];
    const byId = new Map(resources.map((row) => [row.id, row]));
    return automation.resourceIds.map((id) => {
      const row = byId.get(id);
      if (!row) return id;
      const url = row.repoUrl ?? row.targetUrl;
      return url ? `${row.name} (${url})` : row.name;
    });
  }, [automation, resources]);

  const toolNames = useMemo(() => {
    if (!automation) return [];
    return automation.toolIds.map((id) => SECURITY_TOOLS.find((tool) => tool.id === id)?.name ?? id);
  }, [automation]);

  const categoryLabels = useMemo(() => {
    if (!automation) return [];
    return automation.scanCategories.map(
      (id) => SECURITY_TOOL_CATEGORIES.find((row) => row.id === id)?.label ?? id.toUpperCase()
    );
  }, [automation]);

  if (!automation) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{automation.name}</DialogTitle>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted/20 p-3">
          <DetailRow label="Schedule" value={automation.scheduleSummary} />
          <DetailRow
            label="Next run"
            value={formatNextRunAt(automation.nextRunAt, automation.timezone)}
          />
          <DetailRow
            label="Last run"
            value={formatNextRunAt(automation.lastRunAt, automation.timezone)}
          />
          <DetailRow label="Status" value={runStatusLabel(automation.runStatus)} />
          {automation.lastRunError ? (
            <DetailRow label="Last error" value={automation.lastRunError} />
          ) : null}
          <DetailRow label="Repositories" value={resourceNames.join('\n') || '—'} />
          <DetailRow label="Scan types" value={categoryLabels.join(', ') || '—'} />
          <DetailRow label="Tools" value={toolNames.join(', ') || '—'} />
          <DetailRow
            label="S3 upload"
            value={
              automation.s3Enabled
                ? `${automation.s3Bucket ?? '—'} · ${automation.s3Region ?? '—'}`
                : 'Off'
            }
          />
          <DetailRow
            label="Teams"
            value={automation.teamsEnabled ? 'Enabled' : 'Off'}
          />
          <DetailRow label="Enabled" value={automation.enabled ? 'Yes' : 'No'} />
        </div>

        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onEdit(automation);
            }}
          >
            Edit automation
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SecurityAutomationSavedList({
  automations,
  resources,
  togglePending,
  deletePending,
  onToggle,
  onEdit,
  onDelete,
}: {
  automations: SecurityAutomationView[];
  resources: SecurityResourceView[];
  togglePending: boolean;
  deletePending: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: (automation: SecurityAutomationView) => void;
  onDelete: (id: string) => void;
}) {
  const [detailAutomation, setDetailAutomation] = useState<SecurityAutomationView | null>(null);

  if (automations.length === 0) {
    return <p className="text-sm text-muted-foreground">No automations configured yet.</p>;
  }

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="border-b border-border bg-muted/30 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Automation</th>
              <th className="px-3 py-2 font-medium">Next run</th>
              <th className="px-3 py-2 font-medium">Last run</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {automations.map((row) => {
              const isRunning = row.runStatus === 'running';
              return (
                <tr
                  key={row.id}
                  className={cn(
                    'cursor-pointer border-t border-border transition-colors hover:bg-muted/40',
                    isRunning && 'automation-running-blink'
                  )}
                  onClick={() => setDetailAutomation(row)}
                >
                  <td className="px-3 py-2.5">
                    <p className="font-medium text-foreground">{row.name}</p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">{row.scheduleSummary}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {row.s3Enabled ? (
                        <Badge variant="outline" className="text-[9px]">
                          S3
                        </Badge>
                      ) : null}
                      {row.teamsEnabled ? (
                        <Badge variant="outline" className="text-[9px]">
                          Teams
                        </Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-[11px] text-muted-foreground">
                    {row.enabled
                      ? formatNextRunAt(row.nextRunAt, row.timezone)
                      : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-[11px] text-muted-foreground">
                    {formatNextRunAt(row.lastRunAt, row.timezone)}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge variant={runStatusBadgeVariant(row.runStatus)} className="text-[9px]">
                      {runStatusLabel(row.runStatus)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <div
                      className="flex items-center justify-end gap-2"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Switch
                        checked={row.enabled}
                        disabled={togglePending || isRunning}
                        onCheckedChange={(enabled) => onToggle(row.id, enabled)}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-[11px]"
                        onClick={() => onEdit(row)}
                      >
                        Edit
                      </Button>
                      <SecurityIconButton
                        icon={Trash2}
                        label="Delete automation"
                        tone="danger"
                        disabled={isRunning}
                        loading={deletePending}
                        onClick={() => onDelete(row.id)}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <AutomationDetailDialog
        automation={detailAutomation}
        resources={resources}
        open={Boolean(detailAutomation)}
        onOpenChange={(open) => {
          if (!open) setDetailAutomation(null);
        }}
        onEdit={onEdit}
      />
    </>
  );
}

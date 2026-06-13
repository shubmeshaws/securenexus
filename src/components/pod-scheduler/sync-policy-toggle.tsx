'use client';

import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';

interface SyncPolicyToggleProps {
  appName: string;
  instanceId?: string;
  syncPolicy: 'automated' | 'none';
  onUpdated?: (policy: 'automated' | 'none') => void;
  disabled?: boolean;
}

export function SyncPolicyToggle({
  appName,
  instanceId,
  syncPolicy,
  onUpdated,
  disabled,
}: SyncPolicyToggleProps) {
  const [policy, setPolicy] = useState(syncPolicy);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState<'automated' | 'none' | null>(null);
  const [loading, setLoading] = useState(false);

  const isAutomated = policy === 'automated';

  async function applyPolicy(next: 'automated' | 'none') {
    const prev = policy;
    setPolicy(next);
    setLoading(true);
    try {
      const query = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
      await apiFetch(`/api/argocd/apps/${encodeURIComponent(appName)}/sync${query}`, {
        method: 'PATCH',
        body: JSON.stringify({ syncPolicy: next }),
      });
      onUpdated?.(next);
    } catch {
      setPolicy(prev);
    } finally {
      setLoading(false);
      setConfirmOpen(false);
      setPending(null);
    }
  }

  function handleToggle(checked: boolean) {
    const next = checked ? 'automated' : 'none';
    if (next === 'none') {
      setPending(next);
      setConfirmOpen(true);
    } else {
      applyPolicy(next);
    }
  }

  return (
    <>
      <TooltipProvider>
        <div className="flex items-center gap-2">
          <Label htmlFor={`sync-${appName}`} className="text-xs text-muted-foreground">
            {isAutomated ? 'Auto' : 'Manual'}
          </Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <Switch
                  id={`sync-${appName}`}
                  checked={isAutomated}
                  onCheckedChange={handleToggle}
                  disabled={disabled || loading}
                />
              </div>
            </TooltipTrigger>
            {!isAutomated && (
              <TooltipContent>
                ArgoCD will no longer reconcile this app
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      </TooltipProvider>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable ArgoCD sync?</DialogTitle>
            <DialogDescription>
              ArgoCD will no longer reconcile <strong>{appName}</strong>. Manual changes may drift
              from Git.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => pending && applyPolicy(pending)}
              disabled={loading}
            >
              Disable sync
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

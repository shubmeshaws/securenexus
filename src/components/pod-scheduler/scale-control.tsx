'use client';

import { useState } from 'react';
import { CirclePlay, CircleStop } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { Button } from '@/components/ui/button';
import { ReplicaBadge } from '@/components/pod-scheduler/sync-status-badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api-client';
import { deploymentKey, usePodSchedulerStore } from '@/store/pod-scheduler';

interface ScaleControlProps {
  cluster: string;
  namespace: string;
  name: string;
  desiredReplicas: number;
  readyReplicas?: number;
  onScaled?: () => void;
  compact?: boolean;
}

export function ScaleControl({
  cluster,
  namespace,
  name,
  desiredReplicas,
  readyReplicas,
  onScaled,
  compact,
}: ScaleControlProps) {
  const key = deploymentKey(cluster, namespace, name);
  const saved = usePodSchedulerStore(
    (s) => s.savedReplicas[key] ?? Math.max(desiredReplicas, 1)
  );
  const setSavedReplicas = usePodSchedulerStore((s) => s.setSavedReplicas);
  const [confirmStop, setConfirmStop] = useState(false);
  const [loading, setLoading] = useState(false);

  const isStopped = desiredReplicas === 0;

  async function scale(replicas: number) {
    setLoading(true);
    try {
      if (replicas === 0 && desiredReplicas > 0) {
        setSavedReplicas(key, desiredReplicas);
      }
      await apiFetch(
        `/api/k8s/clusters/${encodeURIComponent(cluster)}/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}/scale`,
        { method: 'PATCH', body: JSON.stringify({ replicas }) }
      );
      onScaled?.();
    } finally {
      setLoading(false);
      setConfirmStop(false);
    }
  }

  return (
    <>
      <div className={`flex items-center gap-2 ${compact ? '' : 'flex-wrap'}`}>
        <ReplicaBadge current={readyReplicas ?? desiredReplicas} desired={isStopped ? saved : desiredReplicas} />
        {isStopped ? (
          <Button
            variant="success"
            size="sm"
            onClick={() => scale(saved)}
            disabled={loading}
            className="gap-1"
          >
            <AppIcon icon={CirclePlay} size="xs" />
            Start
          </Button>
        ) : (
          <Button
            variant="danger"
            size="sm"
            onClick={() => setConfirmStop(true)}
            disabled={loading}
            className="gap-1"
          >
            <AppIcon icon={CircleStop} size="xs" />
            Stop
          </Button>
        )}
      </div>

      <Dialog open={confirmStop} onOpenChange={setConfirmStop}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop deployment?</DialogTitle>
            <DialogDescription>
              Scale <strong>{name}</strong> to 0 replicas? Pods will be terminated.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmStop(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => scale(0)} disabled={loading}>
              Stop
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

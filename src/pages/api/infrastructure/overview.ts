import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { getWorkloadSummary } from '@/lib/workload-scan';
import type { InfraState, InfrastructureCluster, InfrastructureOverview } from '@/lib/api-client';

function deriveInfraState(running: number, stopped: number, total: number): InfraState {
  if (total === 0) return 'stopped';
  if (running === total) return 'running';
  if (stopped === total) return 'stopped';
  return 'partial';
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const [registered, workloadScan] = await Promise.all([
      prisma.cluster.findMany({ orderBy: { createdAt: 'desc' } }),
      getWorkloadSummary(),
    ]);

    const merged: InfrastructureCluster[] = registered.map((reg) => {
      const live = workloadScan.byCluster[reg.name];
      const workloads = live ?? { total: 0, running: 0, stopped: 0 };
      const infraState = deriveInfraState(workloads.running, workloads.stopped, workloads.total);

      return {
        id: reg.id,
        name: reg.name,
        provider: reg.provider as 'kubeconfig' | 'aws',
        region: reg.region,
        awsClusterName: reg.awsClusterName,
        status: reg.status as 'connected' | 'disconnected' | 'error',
        infraState,
        nodeGroups: [],
        workloads,
        activeSchedules: 0,
        estimatedSavingsPct: workloads.total > 0 ? Math.round((workloads.stopped / workloads.total) * 100) : 0,
        lastAction: null,
        lastActionAt: reg.lastSyncAt?.toISOString() ?? null,
      };
    });

    for (const [name, workloads] of Object.entries(workloadScan.byCluster)) {
      if (!merged.some((m) => m.name === name)) {
        merged.push({
          id: name,
          name,
          provider: 'kubeconfig',
          region: null,
          awsClusterName: null,
          status: 'connected',
          infraState: deriveInfraState(workloads.running, workloads.stopped, workloads.total),
          nodeGroups: [],
          workloads,
          activeSchedules: 0,
          estimatedSavingsPct: workloads.total > 0 ? Math.round((workloads.stopped / workloads.total) * 100) : 0,
          lastAction: null,
          lastActionAt: null,
        });
      }
    }

    const summary = {
      total: merged.length,
      running: merged.filter((c) => c.infraState === 'running').length,
      stopped: merged.filter((c) => c.infraState === 'stopped').length,
      partial: merged.filter((c) => c.infraState === 'partial').length,
    };

    const overview: InfrastructureOverview = { clusters: merged, summary };
    return res.status(200).json(overview);
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to load infrastructure overview',
    });
  }
}

export default requireAuth(handler);

import type { NextApiResponse } from 'next';
import { requireAuth, requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { scaleDeployment, listPods, getClusterReadyNodeCount } from '@/lib/k8s-client';
import { invalidateWorkloadCache } from '@/lib/workload-scan';
import { scaleDeploymentSchema } from '@/lib/validation';
import { logActivityFromRequest } from '@/lib/activity';
import { buildShutdownActivityDetails } from '@/lib/shutdown-node-count';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { cluster, ns, name } = req.query;
  if (typeof cluster !== 'string' || typeof ns !== 'string' || typeof name !== 'string') {
    return res.status(400).json({ error: 'cluster, ns, and name are required' });
  }

  if (req.method !== 'PATCH') return methodNotAllowed(res, ['PATCH']);

  const parsed = scaleDeploymentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const nodeCount =
      parsed.data.replicas === 0 ? await getClusterReadyNodeCount(cluster) : null;
    const deployment = await scaleDeployment(cluster, ns, name, parsed.data.replicas);
    const pods = await listPods(cluster, ns, name);

    await logActivityFromRequest(req, {
      action: parsed.data.replicas === 0 ? 'scale-down' : 'scale-up',
      cluster,
      namespace: ns,
      appName: name,
      triggeredBy: req.user?.email ?? 'manual',
      status: 'success',
      message: `Scaled to ${parsed.data.replicas} replicas`,
      details:
        parsed.data.replicas === 0
          ? buildShutdownActivityDetails(undefined, nodeCount)
          : undefined,
    });

    invalidateWorkloadCache();
    return res.status(200).json({ deployment, pods });
  } catch (err) {
    await logActivityFromRequest(req, {
      action: parsed.data.replicas === 0 ? 'scale-down' : 'scale-up',
      cluster,
      namespace: ns,
      appName: name,
      triggeredBy: req.user?.email ?? 'manual',
      status: 'failed',
      message: err instanceof Error ? err.message : 'Scale failed',
    });
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to scale deployment',
    });
  }
}

export default requireAdmin(handler);

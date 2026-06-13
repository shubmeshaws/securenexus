import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { listDeployments, listPods } from '@/lib/k8s-client';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { cluster, ns } = req.query;
  if (typeof cluster !== 'string' || typeof ns !== 'string') {
    return res.status(400).json({ error: 'cluster and ns are required' });
  }

  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const deployments = await listDeployments(cluster, ns);
    const withPods = await Promise.all(
      deployments.map(async (dep) => {
        const labelSelector = Object.entries(dep.matchLabels)
          .map(([k, v]) => `${k}=${v}`)
          .join(',');
        const pods = await listPods(cluster, ns, dep.name, labelSelector || undefined);
        return { ...dep, pods };
      })
    );
    return res.status(200).json({ deployments: withPods });
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to list deployments',
      deployments: [],
    });
  }
}

export default requireAuth(handler);

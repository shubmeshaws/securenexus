import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { listWorkloads } from '@/lib/k8s-client';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { cluster, ns } = req.query;
  if (typeof cluster !== 'string' || typeof ns !== 'string') {
    return res.status(400).json({ error: 'cluster and ns are required' });
  }

  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const workloads = await listWorkloads(cluster, ns);
    return res.status(200).json({ workloads });
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to list workloads',
      workloads: [],
    });
  }
}

export default requireAuth(handler);

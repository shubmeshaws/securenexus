import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { listClusters } from '@/lib/k8s-client';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const clusters = await listClusters();
    return res.status(200).json({ clusters });
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to list clusters',
      clusters: [],
    });
  }
}

export default requireAuth(handler);

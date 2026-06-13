import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { listNamespaces } from '@/lib/k8s-client';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { cluster } = req.query;
  if (typeof cluster !== 'string') {
    return res.status(400).json({ error: 'cluster is required' });
  }

  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const namespaces = await listNamespaces(cluster);
    return res.status(200).json({ namespaces });
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to list namespaces',
      namespaces: [],
    });
  }
}

export default requireAuth(handler);

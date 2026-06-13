import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import argocdClient from '@/lib/argocd-client';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const apps = await argocdClient.listApplications();
    return res.status(200).json({ degraded: false, apps });
  } catch (err) {
    return res.status(200).json({
      degraded: true,
      message: err instanceof Error ? err.message : 'Failed to fetch apps',
      apps: [],
    });
  }
}

export default requireAuth(handler);

import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import argocdClient from '@/lib/argocd-client';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { appName } = req.query;
  if (typeof appName !== 'string') {
    return res.status(400).json({ error: 'appName is required' });
  }

  if (req.method === 'GET') {
    try {
      const app = await argocdClient.getApplication(appName);
      return res.status(200).json(app);
    } catch (err) {
      return res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to fetch app',
      });
    }
  }

  return methodNotAllowed(res, ['GET']);
}

export default requireAuth(handler);

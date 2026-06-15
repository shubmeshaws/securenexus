import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { listArgoCDAppSourceViews } from '@/lib/argocd-app-sources';

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  const appSources = await listArgoCDAppSourceViews();
  return res.status(200).json({ appSources });
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  return methodNotAllowed(res, ['GET']);
}

export default requireAdmin(handler);

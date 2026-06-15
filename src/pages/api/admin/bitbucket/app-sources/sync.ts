import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { syncArgoCDAppSources } from '@/lib/argocd-app-sources';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const result = await syncArgoCDAppSources();
  return res.status(200).json(result);
}

export default requireAdmin(handler);

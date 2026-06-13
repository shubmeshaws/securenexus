import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { listArgoCDInstanceViews } from '@/lib/argocd-instances';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const instances = await listArgoCDInstanceViews();
  return res.status(200).json({
    instances: instances
      .filter((i) => i.enabled && i.tokenSet)
      .map((i) => ({ id: i.id, name: i.name, serverUrl: i.serverUrl })),
  });
}

export default requireAuth(handler);

import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { getDevOpsContactsPublicView } from '@/lib/devops-contacts';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const data = await getDevOpsContactsPublicView();
  return res.status(200).json(data);
}

export default requireAuth(handler);

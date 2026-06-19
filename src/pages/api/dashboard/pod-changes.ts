import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { getPodChanges, parsePodChangesQuery } from '@/lib/pod-changes-service';

async function getHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    const data = await getPodChanges(parsePodChangesQuery(req.query));
    return res.status(200).json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load pod changes';
    return res.status(500).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  return methodNotAllowed(res, ['GET']);
}

export default requireAuth(handler);

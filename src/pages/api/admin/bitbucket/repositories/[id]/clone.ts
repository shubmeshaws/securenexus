import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { cloneRepository } from '@/lib/git-sync-service';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const { id } = req.query;
  if (typeof id !== 'string') return res.status(400).json({ error: 'id is required' });

  const result = await cloneRepository(id, true);
  return res.status(200).json(result);
}

export default requireAdmin(handler);

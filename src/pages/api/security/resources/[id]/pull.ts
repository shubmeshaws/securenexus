import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { pullSecurityResource } from '@/lib/security-service';

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'Missing resource id' });

  try {
    const resource = await pullSecurityResource(id);
    return res.status(200).json({ resource, message: `Pulled latest changes for ${resource.name}.` });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pull failed';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'POST') return postHandler(req, res);
  return methodNotAllowed(res, ['POST']);
}

export default requireAdmin(handler);

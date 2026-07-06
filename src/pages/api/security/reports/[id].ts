import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { deleteSecurityReport } from '@/lib/security-service';

async function deleteHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'Missing report id' });

  try {
    await deleteSecurityReport(id);
    return res.status(204).end();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete report';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'DELETE') return deleteHandler(req, res);
  return methodNotAllowed(res, ['DELETE']);
}

export default requireAdmin(handler);

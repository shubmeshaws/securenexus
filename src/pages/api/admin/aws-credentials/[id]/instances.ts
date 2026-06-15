import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { listEc2InstancesForCredential } from '@/lib/aws-credential-store';

async function getHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = req.query.id as string;

  try {
    const instances = await listEc2InstancesForCredential(id);
    return res.status(200).json({ instances });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list EC2 instances';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  return methodNotAllowed(res, ['GET']);
}

export default requireAdmin(handler);

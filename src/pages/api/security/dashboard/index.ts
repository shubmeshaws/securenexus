import type { NextApiResponse } from 'next';
import { methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requireSecurityTab } from '@/lib/security-permission-auth';
import { getSecurityDashboardStats } from '@/lib/security-service';

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    const dashboard = await getSecurityDashboardStats();
    return res.status(200).json({ dashboard });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load security dashboard';
    return res.status(500).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  return methodNotAllowed(res, ['GET']);
}

export default requireSecurityTab('securityDashboard')(handler);

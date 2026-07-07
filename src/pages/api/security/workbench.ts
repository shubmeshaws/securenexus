import type { NextApiResponse } from 'next';
import { methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requireAnySecurityTab } from '@/lib/security-permission-auth';
import { getSecurityWorkbenchData } from '@/lib/security-service';

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    const data = await getSecurityWorkbenchData();
    return res.status(200).json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load security workbench';
    return res.status(500).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  return methodNotAllowed(res, ['GET']);
}

export default requireAnySecurityTab(['securityScan', 'securityAutomation'])(handler);

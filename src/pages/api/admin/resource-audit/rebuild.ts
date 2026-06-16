import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  getResourceAuditRebuildStatus,
  startResourceAuditRebuild,
} from '@/lib/resource-audit-rebuild';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, status: getResourceAuditRebuildStatus() });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  const outcome = startResourceAuditRebuild();
  if (outcome === 'already_running') {
    return res.status(409).json({
      ok: false,
      message: 'A rebuild is already running',
      status: getResourceAuditRebuildStatus(),
    });
  }

  return res.status(202).json({
    ok: true,
    started: true,
    message: 'Rebuild started in the background. This may take several minutes.',
    status: getResourceAuditRebuildStatus(),
  });
}

export default requireAdmin(handler);

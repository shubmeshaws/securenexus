import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { getResourceAuditSummary } from '@/lib/resource-audit-service';
import { parseResourceAuditFilters } from '@/lib/resource-audit-query';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const filters = parseResourceAuditFilters(req.query as Record<string, unknown>);
  const summary = await getResourceAuditSummary(filters);
  return res.status(200).json({ summary });
}

export default requireAuth(handler);

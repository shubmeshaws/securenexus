import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { exportResourceAuditRows } from '@/lib/resource-audit-service';
import { resourceAuditToCsv } from '@/lib/resource-audit-export';
import { parseResourceAuditFilters } from '@/lib/resource-audit-query';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const filters = parseResourceAuditFilters(req.query as Record<string, unknown>);
  const rows = await exportResourceAuditRows(filters);

  const csv = resourceAuditToCsv(rows);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="resource-change-audit-${stamp}.csv"`
  );
  return res.status(200).send(csv);
}

export default requireAuth(handler);

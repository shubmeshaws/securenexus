import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { getActivityLogs } from '@/lib/activity';
import { activityLogsToCsv, activityLogsToPdfBuffer } from '@/lib/activity-export';
import { formatTimestampIST } from '@/lib/utils';

function parseDateQuery(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const format = typeof req.query.format === 'string' ? req.query.format : 'csv';
  const limit = Math.min(5000, Math.max(1, parseInt(String(req.query.limit ?? '5000'), 10) || 5000));
  const from = parseDateQuery(req.query.from);
  const to = parseDateQuery(req.query.to);

  const logs = await getActivityLogs(limit, { from, to });
  const stamp = new Date().toISOString().slice(0, 10);
  const rangeMeta = {
    from: from ? formatTimestampIST(from.toISOString()) : undefined,
    to: to ? formatTimestampIST(to.toISOString()) : undefined,
  };

  if (format === 'pdf') {
    const body = await activityLogsToPdfBuffer(logs, rangeMeta);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="activity-logs-${stamp}.pdf"`);
    return res.status(200).send(body);
  }

  const csv = activityLogsToCsv(logs);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="activity-logs-${stamp}.csv"`);
  return res.status(200).send(csv);
}

export default requireAuth(handler);

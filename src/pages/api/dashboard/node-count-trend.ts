import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { getNodeCountTrendData } from '@/lib/node-count-trend-service';
import type { NodeCountTrendQuery } from '@/lib/node-count-trend-data';
import { parseDashboardDateQuery } from '@/lib/dashboard-date-range';

function parseQuery(req: AuthenticatedRequest): NodeCountTrendQuery {
  const cluster = typeof req.query.cluster === 'string' ? req.query.cluster : undefined;
  const dateQuery = parseDashboardDateQuery(req.query);
  return { cluster, ...dateQuery };
}

async function getHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    const data = await getNodeCountTrendData(parseQuery(req));
    return res.status(200).json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load node count trend';
    return res.status(500).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  return methodNotAllowed(res, ['GET']);
}

export default requireAuth(handler);

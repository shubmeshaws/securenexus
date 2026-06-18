import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { getNodeCountTrendData } from '@/lib/node-count-trend-service';
import type { NodeCountMetric } from '@/lib/node-count-trend-data';

function parseQuery(req: AuthenticatedRequest) {
  const daysRaw = req.query.days;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  const metricRaw = typeof req.query.metric === 'string' ? req.query.metric : undefined;
  const cluster = typeof req.query.cluster === 'string' ? req.query.cluster : undefined;
  const days =
    typeof daysRaw === 'string' && /^\d+$/.test(daysRaw) ? Number.parseInt(daysRaw, 10) : undefined;
  const metric: NodeCountMetric = metricRaw === 'max' ? 'max' : 'average';
  return { days, from, to, metric, cluster };
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

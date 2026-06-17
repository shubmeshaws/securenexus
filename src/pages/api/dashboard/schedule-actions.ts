import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { getScheduleActionsChartData } from '@/lib/dashboard-schedule-actions';

function parseQuery(req: AuthenticatedRequest) {
  const daysRaw = req.query.days;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  const days =
    typeof daysRaw === 'string' && /^\d+$/.test(daysRaw) ? Number.parseInt(daysRaw, 10) : undefined;
  return { days, from, to };
}

async function getHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    const data = await getScheduleActionsChartData(parseQuery(req));
    return res.status(200).json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load schedule actions';
    return res.status(500).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  return methodNotAllowed(res, ['GET']);
}

export default requireAuth(handler);

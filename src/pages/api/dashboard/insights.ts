import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { getDashboardInsights } from '@/lib/dashboard-metrics';
import { parseDashboardDateQuery } from '@/lib/dashboard-date-range';

async function getHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    const dateQuery = parseDashboardDateQuery(req.query);
    const schedules = await prisma.schedule.findMany({ where: { enabled: true } });
    const insights = await getDashboardInsights(schedules, dateQuery);
    return res.status(200).json(insights);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load dashboard insights';
    return res.status(500).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  return methodNotAllowed(res, ['GET']);
}

export default requireAuth(handler);

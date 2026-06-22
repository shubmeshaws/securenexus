import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requirePermission } from '@/lib/permission-auth';
import prisma from '@/lib/prisma';
import { schedulesToCsv } from '@/lib/schedule-csv';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const schedules = await prisma.schedule.findMany({ orderBy: { name: 'asc' } });
  const csv = schedulesToCsv(schedules);
  const stamp = new Date().toISOString().slice(0, 10);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="schedules-${stamp}.csv"`);
  return res.status(200).send(csv);
}

export default requireAuth(requirePermission('scheduleEdit')(handler));

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requirePermission } from '@/lib/permission-auth';
import prisma from '@/lib/prisma';
import { updateScheduleBodySchema, mergeScheduleUpdate } from '@/lib/validation';
import { computeNextRun } from '@/lib/scheduler';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { id } = req.query;
  if (typeof id !== 'string') {
    return res.status(400).json({ error: 'id is required' });
  }

  if (req.method === 'PATCH') {
    const parsed = updateScheduleBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const existing = await prisma.schedule.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Schedule not found' });

    let merged;
    try {
      merged = mergeScheduleUpdate(existing, parsed.data);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.flatten() });
      }
      throw err;
    }

    const nextRun = computeNextRun({ ...existing, ...merged } as typeof existing);

    const schedule = await prisma.schedule.update({
      where: { id },
      data: { ...merged, nextRun },
    });

    return res.status(200).json({ schedule });
  }

  if (req.method === 'DELETE') {
    const existing = await prisma.schedule.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Schedule not found' });

    await prisma.schedule.delete({ where: { id } });
    return res.status(200).json({ success: true });
  }

  return methodNotAllowed(res, ['PATCH', 'DELETE']);
}

export default requirePermission('scheduleEdit')(handler);

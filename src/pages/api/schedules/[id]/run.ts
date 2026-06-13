import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { enforcePermission } from '@/lib/permission-auth';
import prisma from '@/lib/prisma';
import { runScheduleSchema } from '@/lib/validation';
import { runScheduleNow } from '@/lib/scheduler';
import { logActivityFromRequest } from '@/lib/activity';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { id } = req.query;
  if (typeof id !== 'string') {
    return res.status(400).json({ error: 'id is required' });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const parsed = runScheduleSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const permission = parsed.data.mode === 'startup' ? 'scheduleStart' : 'scheduleStop';
  if (!(await enforcePermission(req, res, permission))) return;

  const schedule = await prisma.schedule.findUnique({ where: { id } });
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

  try {
    await runScheduleNow(id, parsed.data.mode, req.user?.email ?? 'manual');
    await logActivityFromRequest(req, {
      action: 'schedule-run',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: schedule.appName,
      triggeredBy: req.user?.email ?? 'manual',
      status: 'success',
      message: `Manual ${parsed.data.mode} executed`,
    });
    const updated = await prisma.schedule.findUnique({ where: { id } });
    return res.status(200).json({ schedule: updated });
  } catch (err) {
    await logActivityFromRequest(req, {
      action: 'schedule-run',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: schedule.appName,
      triggeredBy: req.user?.email ?? 'manual',
      status: 'failed',
      message: err instanceof Error ? err.message : 'Run failed',
    });
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to run schedule',
    });
  }
}

export default requireAuth(handler);

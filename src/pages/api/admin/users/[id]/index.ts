import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { z } from 'zod';
import { parseUserPermissions } from '@/lib/user-permissions';
import {
  clearUserScheduleGrants,
  replaceUserScheduleGrants,
} from '@/lib/schedule-access';

const permissionsSchema = z.object({
  scheduleEdit: z.boolean(),
  scheduleStart: z.boolean(),
  scheduleStop: z.boolean(),
  liveScheduleStop: z.boolean(),
  instantSchedule: z.boolean(),
  scheduleAccessMode: z.enum(['all', 'selected']),
});

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  displayName: z.string().min(1).max(100).optional(),
  role: z.enum(['admin', 'analyst', 'viewer']).optional(),
  active: z.boolean().optional(),
  permissions: permissionsSchema.optional(),
  scheduleIds: z.array(z.string()).optional(),
});

async function sanitizeUser(u: Record<string, unknown>, scheduleIds: string[]) {
  const { passwordHash, ...safe } = u;
  if (safe.permissions !== undefined && safe.permissions !== null) {
    safe.permissions = parseUserPermissions(safe.permissions);
  }
  return { ...safe, scheduleIds };
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { id } = req.query;
  if (typeof id !== 'string') return res.status(400).json({ error: 'id is required' });

  if (req.method === 'PUT') {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'User not found' });

    const { permissions, role, scheduleIds, ...rest } = parsed.data;
    const data: Record<string, unknown> = { ...rest };
    if (role !== undefined) {
      data.role = role;
      if (role === 'admin') {
        data.permissions = null;
        await clearUserScheduleGrants(id);
      }
    }
    if (permissions !== undefined) {
      data.permissions = permissions;
      if (permissions.scheduleAccessMode === 'all') {
        await clearUserScheduleGrants(id);
      }
    }
    if (scheduleIds !== undefined) {
      const mode =
        permissions?.scheduleAccessMode ??
        parseUserPermissions(existing.permissions).scheduleAccessMode;
      if (mode === 'selected') {
        const valid = await prisma.schedule.findMany({
          where: { id: { in: scheduleIds } },
          select: { id: true },
        });
        await replaceUserScheduleGrants(
          id,
          valid.map((s) => s.id)
        );
      } else {
        await clearUserScheduleGrants(id);
      }
    }

    const user = await prisma.user.update({ where: { id }, data });
    const grants = await prisma.userScheduleGrant.findMany({
      where: { userId: id },
      select: { scheduleId: true },
    });
    return res.status(200).json({
      user: await sanitizeUser(
        user as unknown as Record<string, unknown>,
        grants.map((g) => g.scheduleId)
      ),
    });
  }

  if (req.method === 'DELETE') {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'User not found' });
    await prisma.user.delete({ where: { id } });
    return res.status(200).json({ success: true });
  }

  return methodNotAllowed(res, ['PUT', 'DELETE']);
}

export default requireAdmin(handler);

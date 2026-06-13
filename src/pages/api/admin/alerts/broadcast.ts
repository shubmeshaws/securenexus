import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { logActivityFromRequest, pruneBroadcastNotifications } from '@/lib/activity';

const bodySchema = z.object({
  title: z.string().min(1).max(120),
  message: z.string().min(1).max(1000),
  type: z.enum(['info', 'success', 'warning', 'error']),
});

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { title, message, type } = parsed.data;

  await logActivityFromRequest(req, {
    action: 'alert-broadcast',
    cluster: '—',
    namespace: '—',
    appName: '—',
    triggeredBy: req.user?.email ?? 'admin',
    status: 'success',
    message,
    details: JSON.stringify({ title, notifType: type }),
  });

  await pruneBroadcastNotifications();

  return res.status(200).json({
    ok: true,
    message: 'Broadcast sent — all users will see it in the bell icon',
  });
}

export default requireAdmin(handler);

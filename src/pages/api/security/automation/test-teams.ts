import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requireSecurityTab } from '@/lib/security-permission-auth';
import { sendAutomationTeamsTestNotification } from '@/lib/security-automation-teams';

const bodySchema = z.object({
  name: z.string().optional(),
  teamsWebhookUrl: z.string().optional(),
  scanCategories: z.array(z.string()).optional(),
  resourceIds: z.array(z.string()).optional(),
  s3Bucket: z.string().optional(),
  s3Region: z.string().optional(),
});

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const result = await sendAutomationTeamsTestNotification(parsed.data);
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send Teams test notification';
    return res.status(400).json({ ok: false, message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'POST') return postHandler(req, res);
  return methodNotAllowed(res, ['POST']);
}

export default requireSecurityTab('securityAutomation')(handler);

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  getTeamsWebhookUrl,
  SECRET_PLACEHOLDER,
  updateAlertSettings,
} from '@/lib/alert-settings';
import { sendTeamsWebhook } from '@/lib/teams-webhook';

const bodySchema = z.object({
  teamsWebhookUrl: z.string().optional(),
});

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  let webhookUrl = parsed.data.teamsWebhookUrl?.trim();
  if (!webhookUrl || webhookUrl === SECRET_PLACEHOLDER) {
    webhookUrl = (await getTeamsWebhookUrl()) ?? undefined;
  }

  if (!webhookUrl) {
    return res.status(400).json({ ok: false, message: 'Teams webhook URL is required' });
  }

  if (parsed.data.teamsWebhookUrl && parsed.data.teamsWebhookUrl !== SECRET_PLACEHOLDER) {
    await updateAlertSettings({ teamsWebhookUrl: parsed.data.teamsWebhookUrl }, req.user?.email);
  }

  const result = await sendTeamsWebhook(webhookUrl, {
    title: 'Test Alert',
    message: 'This is a test message from SecureNexus Alerts.',
    action: 'schedule-run',
    cluster: 'test-cluster',
    namespace: 'default',
    appName: 'test-workload',
    triggeredBy: req.user?.email ?? 'admin',
    status: 'success',
    userName: req.user?.email,
  });

  return res.status(result.ok ? 200 : 400).json(result);
}

export default requireAdmin(handler);

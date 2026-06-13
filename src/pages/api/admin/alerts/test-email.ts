import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  getAlertConfigFull,
  updateAlertSettings,
  SECRET_PLACEHOLDER,
} from '@/lib/alert-settings';
import { sendEmailAlert } from '@/lib/email-alerts';

const bodySchema = z.object({
  emailRecipients: z.array(z.string().email()).optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.number().optional(),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
  emailFrom: z.string().optional(),
});

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  if (parsed.data.smtpPassword && parsed.data.smtpPassword !== SECRET_PLACEHOLDER) {
    await updateAlertSettings(
      {
        smtpPassword: parsed.data.smtpPassword,
        smtpHost: parsed.data.smtpHost,
        smtpPort: parsed.data.smtpPort,
        smtpUser: parsed.data.smtpUser,
        emailFrom: parsed.data.emailFrom,
        emailRecipients: parsed.data.emailRecipients,
      },
      req.user?.email
    );
  }

  const config = await getAlertConfigFull();
  const recipients = parsed.data.emailRecipients ?? config.emailRecipients;

  const result = await sendEmailAlert(
    {
      ...config,
      smtpHost: parsed.data.smtpHost ?? config.smtpHost,
      smtpPort: parsed.data.smtpPort ?? config.smtpPort,
      smtpUser: parsed.data.smtpUser ?? config.smtpUser,
      emailFrom: parsed.data.emailFrom ?? config.emailFrom,
    },
    {
      title: 'Test Alert',
      message: 'This is a test email from SecureNexus Alerts.',
      action: 'schedule-run',
      cluster: 'test-cluster',
      namespace: 'default',
      appName: 'test-workload',
      triggeredBy: req.user?.email ?? 'admin',
      status: 'success',
      userName: req.user?.email,
    },
    recipients
  );

  return res.status(result.ok ? 200 : 400).json(result);
}

export default requireAdmin(handler);

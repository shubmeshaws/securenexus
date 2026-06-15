import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import type { ActivityAction } from '@/lib/activity';
import {
  getAlertSettings,
  updateAlertSettings,
  DEFAULT_ALERT_EVENTS,
} from '@/lib/alert-settings';

const activityActionSchema = z.enum([
  'sync-off',
  'sync-on',
  'scale-down',
  'scale-up',
  'schedule-run',
  'schedule-shutdown',
  'schedule-startup',
  'infra-shutdown',
  'infra-startup',
  'resource-change',
  'alert-broadcast',
]);

const updateSchema = z.object({
  inAppEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  teamsEnabled: z.boolean().optional(),
  emailRecipients: z.array(z.string()).optional(),
  emailFrom: z.string().optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpUser: z.string().optional(),
  smtpSecure: z.boolean().optional(),
  teamsWebhookUrl: z.string().optional(),
  smtpPassword: z.string().optional(),
  events: z.array(activityActionSchema).optional(),
  resourceChangeThresholdUsd: z.number().min(0).max(10000).optional(),
});

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const settings = await getAlertSettings();
    return res.status(200).json({ settings, availableEvents: DEFAULT_ALERT_EVENTS });
  }

  if (req.method === 'PUT') {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const settings = await updateAlertSettings(
      {
        ...parsed.data,
        events: parsed.data.events as ActivityAction[] | undefined,
        resourceChangeThresholdUsd: parsed.data.resourceChangeThresholdUsd,
      },
      req.user?.email
    );
    return res.status(200).json({ settings });
  }

  return methodNotAllowed(res, ['GET', 'PUT']);
}

export default requireAdmin(handler);

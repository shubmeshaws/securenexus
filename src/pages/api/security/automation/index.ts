import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  createSecurityAutomation,
  listSecurityAutomations,
} from '@/lib/security-automation-service';
import { z } from 'zod';

const automationBodySchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  scheduleTime: z.string().min(1),
  scheduleDays: z.array(z.number().int().min(0).max(6)),
  timezone: z.string().optional(),
  resourceIds: z.array(z.string()),
  scanCategories: z.array(z.enum(['sast', 'sca', 'dast', 'iac', 'secrets'])),
  toolIds: z.array(z.string()),
  s3Enabled: z.boolean().optional(),
  s3Bucket: z.string().optional(),
  s3Region: z.string().optional(),
  s3Prefix: z.string().optional(),
  s3AccessKeyId: z.string().optional(),
  s3SecretAccessKey: z.string().optional(),
  teamsEnabled: z.boolean().optional(),
  teamsWebhookUrl: z.string().optional(),
});

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    const automations = await listSecurityAutomations();
    return res.status(200).json({ automations });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list automations';
    return res.status(500).json({ error: message });
  }
}

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = automationBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const automation = await createSecurityAutomation({
      ...parsed.data,
      createdBy: req.user?.email,
    });
    return res.status(201).json({ automation });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create automation';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return postHandler(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

export default requireAdmin(handler);

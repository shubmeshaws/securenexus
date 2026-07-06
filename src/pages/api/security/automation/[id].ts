import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  deleteSecurityAutomation,
  updateSecurityAutomation,
} from '@/lib/security-automation-service';
import { z } from 'zod';

const automationUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  scheduleTime: z.string().min(1).optional(),
  scheduleDays: z.array(z.number().int().min(0).max(6)).optional(),
  timezone: z.string().optional(),
  resourceIds: z.array(z.string()).optional(),
  scanCategories: z.array(z.enum(['sast', 'sca', 'dast', 'iac', 'secrets'])).optional(),
  toolIds: z.array(z.string()).optional(),
  s3Enabled: z.boolean().optional(),
  s3Bucket: z.string().nullable().optional(),
  s3Region: z.string().nullable().optional(),
  s3Prefix: z.string().nullable().optional(),
  s3AccessKeyId: z.string().nullable().optional(),
  s3SecretAccessKey: z.string().nullable().optional(),
  teamsEnabled: z.boolean().optional(),
  teamsWebhookUrl: z.string().nullable().optional(),
});

async function putHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'Missing automation id' });

  const parsed = automationUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const automation = await updateSecurityAutomation(id, parsed.data);
    return res.status(200).json({ automation });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update automation';
    return res.status(400).json({ error: message });
  }
}

async function deleteHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'Missing automation id' });

  try {
    await deleteSecurityAutomation(id);
    return res.status(204).end();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete automation';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'PUT') return putHandler(req, res);
  if (req.method === 'DELETE') return deleteHandler(req, res);
  return methodNotAllowed(res, ['PUT', 'DELETE']);
}

export default requireAdmin(handler);

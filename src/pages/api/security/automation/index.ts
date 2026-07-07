import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  createSecurityAutomation,
  listSecurityAutomations,
} from '@/lib/security-automation-service';
import { automationBodySchema } from '@/lib/security-automation-api-schema';
import { z } from 'zod';

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
      scheduleFrequency: parsed.data.scheduleFrequency ?? 'weekly',
      scheduleDayOfMonth: parsed.data.scheduleDayOfMonth ?? null,
      scheduleMonth: parsed.data.scheduleMonth ?? null,
      scheduleStartDate: parsed.data.scheduleStartDate ?? null,
      awsCredentialId: parsed.data.awsCredentialId ?? null,
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

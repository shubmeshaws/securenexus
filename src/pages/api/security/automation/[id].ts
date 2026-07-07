import type { NextApiResponse } from 'next';
import { methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requireSecurityTab } from '@/lib/security-permission-auth';
import {
  deleteSecurityAutomation,
  updateSecurityAutomation,
} from '@/lib/security-automation-service';
import { automationUpdateSchema } from '@/lib/security-automation-api-schema';
import { z } from 'zod';

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

export default requireSecurityTab('securityAutomation')(handler);

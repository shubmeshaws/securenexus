import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { listSecurityToolSettings, setSecurityToolEnabled } from '@/lib/security-service';
import { z } from 'zod';

const updateSchema = z.object({
  toolId: z.string().min(1),
  enabled: z.boolean(),
});

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    const tools = await listSecurityToolSettings();
    return res.status(200).json({ tools });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load security tools';
    return res.status(500).json({ error: message });
  }
}

async function putHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    await setSecurityToolEnabled(parsed.data.toolId, parsed.data.enabled);
    const tools = await listSecurityToolSettings();
    return res.status(200).json({ tools });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update tool';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'PUT') return putHandler(req, res);
  return methodNotAllowed(res, ['GET', 'PUT']);
}

export default requireAdmin(handler);

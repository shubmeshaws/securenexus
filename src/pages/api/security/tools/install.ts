import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  getToolInstallJob,
  startToolInstallJob,
} from '@/lib/security/tool-install-job';
import { z } from 'zod';

const installSchema = z.object({
  toolId: z.string().min(1),
  osType: z.enum(['macos', 'ubuntu', 'linux']),
  enableAfter: z.boolean().optional(),
});

function setNoCacheHeaders(res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  setNoCacheHeaders(res);

  if (req.method === 'GET') {
    return res.status(200).json(getToolInstallJob());
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  const parsed = installSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const started = startToolInstallJob(
    parsed.data.toolId,
    parsed.data.osType,
    parsed.data.enableAfter ?? true
  );

  if (!started) {
    return res.status(200).json(getToolInstallJob());
  }

  return res.status(202).json(getToolInstallJob());
}

export default requireAdmin(handler);

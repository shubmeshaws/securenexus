import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { installSecurityToolRuntime } from '@/lib/security-service';
import { z } from 'zod';

const installSchema = z.object({
  toolId: z.string().min(1),
  osType: z.enum(['macos', 'ubuntu', 'linux']),
  enableAfter: z.boolean().optional(),
});

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = installSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const result = await installSecurityToolRuntime(parsed.data.toolId, {
      enableAfter: parsed.data.enableAfter ?? true,
      osType: parsed.data.osType,
    });
    return res.status(200).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Installation failed';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'POST') return postHandler(req, res);
  return methodNotAllowed(res, ['POST']);
}

export default requireAdmin(handler);

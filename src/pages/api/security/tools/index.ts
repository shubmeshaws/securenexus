import type { NextApiResponse } from 'next';
import { methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requireSecurityTab } from '@/lib/security-permission-auth';
import { listSecurityToolSettings, setSecurityToolEnabled, updateSecurityToolScanOptions } from '@/lib/security-service';
import { z } from 'zod';
import { parseGitleaksScanOptions } from '@/lib/security/gitleaks-options';

const updateSchema = z.object({
  toolId: z.string().min(1),
  enabled: z.boolean().optional(),
  scanOptions: z
    .object({
      mode: z.enum([
        'detect',
        'detect-verbose',
        'protect',
        'protect-staged',
        'detect-no-git',
      ]),
    })
    .optional(),
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
    if (parsed.data.scanOptions) {
      const tools = await updateSecurityToolScanOptions(
        parsed.data.toolId,
        parseGitleaksScanOptions(parsed.data.scanOptions)
      );
      return res.status(200).json({ tools });
    }

    if (typeof parsed.data.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled or scanOptions is required' });
    }

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

export default requireSecurityTab('securityTools')(handler);

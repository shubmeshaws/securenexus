import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { testArgoCDConnection } from '@/lib/argocd-client';
import {
  getSetting,
  normalizeArgoCDServer,
  SECRET_PLACEHOLDER,
  SETTING_KEYS,
} from '@/lib/settings';

const bodySchema = z.object({
  argocdServer: z.string().min(1),
  argocdToken: z.string().optional(),
  argocdInsecureTls: z.boolean().optional(),
});

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { argocdServer, argocdInsecureTls } = parsed.data;
  let token = parsed.data.argocdToken?.trim() ?? '';

  if (!token || token === SECRET_PLACEHOLDER) {
    token = (await getSetting(SETTING_KEYS.ARGOCD_TOKEN)) ?? '';
  }

  const result = await testArgoCDConnection({
    server: normalizeArgoCDServer(argocdServer),
    token,
    insecureTls: argocdInsecureTls,
  });

  return res.status(result.ok ? 200 : 400).json(result);
}

export default requireAdmin(handler);

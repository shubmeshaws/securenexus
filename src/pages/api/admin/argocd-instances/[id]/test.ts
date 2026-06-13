import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { getArgoCDInstanceConfig, SECRET_PLACEHOLDER } from '@/lib/argocd-instances';
import { testArgoCDConnection } from '@/lib/argocd-client';
import { z } from 'zod';

const testSchema = z.object({
  serverUrl: z.string().min(1).optional(),
  token: z.string().optional(),
  insecureTls: z.boolean().optional(),
});

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const { id } = req.query;
  if (typeof id !== 'string') return res.status(400).json({ error: 'id is required' });

  const parsed = testSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await getArgoCDInstanceConfig(id);
  if (!existing && !parsed.data.serverUrl) {
    return res.status(404).json({ error: 'ArgoCD instance not found' });
  }

  let token = parsed.data.token?.trim() ?? '';
  if ((!token || token === SECRET_PLACEHOLDER) && existing) {
    token = existing.token;
  }

  const serverUrl = parsed.data.serverUrl ?? existing?.serverUrl ?? '';
  const insecureTls = parsed.data.insecureTls ?? existing?.insecureTls ?? false;

  const result = await testArgoCDConnection({ server: serverUrl, token, insecureTls });
  return res.status(result.ok ? 200 : 400).json(result);
}

export default requireAdmin(handler);

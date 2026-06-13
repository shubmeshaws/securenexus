import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  createArgoCDInstance,
  listArgoCDInstanceViews,
  updateArgoCDInstance,
  deleteArgoCDInstance,
} from '@/lib/argocd-instances';
import { z } from 'zod';

const createSchema = z.object({
  name: z.string().min(1).max(80),
  serverUrl: z.string().min(1),
  token: z.string().min(1),
  insecureTls: z.boolean().optional(),
  enabled: z.boolean().optional(),
  clusterNames: z.array(z.string()).optional(),
});

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  const instances = await listArgoCDInstanceViews();
  return res.status(200).json({ instances });
}

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const instance = await createArgoCDInstance(parsed.data);
    return res.status(201).json({ instance });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create ArgoCD instance';
    if (message.includes('Unique constraint')) {
      return res.status(409).json({ error: 'An ArgoCD instance with this name already exists' });
    }
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return postHandler(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

export default requireAdmin(handler);

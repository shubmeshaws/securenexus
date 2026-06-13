import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { updateArgoCDInstance, deleteArgoCDInstance } from '@/lib/argocd-instances';
import { z } from 'zod';

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  serverUrl: z.string().min(1).optional(),
  token: z.string().optional(),
  insecureTls: z.boolean().optional(),
  enabled: z.boolean().optional(),
  clusterNames: z.array(z.string()).optional(),
});

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { id } = req.query;
  if (typeof id !== 'string') return res.status(400).json({ error: 'id is required' });

  if (req.method === 'PUT') {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const instance = await updateArgoCDInstance(id, parsed.data);
      return res.status(200).json({ instance });
    } catch {
      return res.status(404).json({ error: 'ArgoCD instance not found' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await deleteArgoCDInstance(id);
      return res.status(200).json({ success: true });
    } catch {
      return res.status(404).json({ error: 'ArgoCD instance not found' });
    }
  }

  return methodNotAllowed(res, ['PUT', 'DELETE']);
}

export default requireAdmin(handler);

import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { deleteSecurityResource, updateSecurityResource } from '@/lib/security-service';
import { z } from 'zod';

const updateSchema = z.object({
  name: z.string().optional(),
  repoUrl: z.string().optional(),
  defaultBranch: z.string().nullable().optional(),
  targetUrl: z.string().optional(),
  description: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

async function putHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'Missing resource id' });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const resource = await updateSecurityResource(id, parsed.data);
    return res.status(200).json({ resource });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update resource';
    return res.status(400).json({ error: message });
  }
}

async function deleteHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'Missing resource id' });

  try {
    await deleteSecurityResource(id);
    return res.status(200).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete resource';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'PUT') return putHandler(req, res);
  if (req.method === 'DELETE') return deleteHandler(req, res);
  return methodNotAllowed(res, ['PUT', 'DELETE']);
}

export default requireAdmin(handler);

import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { deleteGitRepository, updateGitRepository } from '@/lib/git-repositories';
import { z } from 'zod';

const updateSchema = z.object({
  defaultBranch: z.string().optional().nullable(),
  pullIntervalMin: z.coerce.number().int().min(1).max(525600).optional(),
  enabled: z.boolean().optional(),
});

async function putHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { id } = req.query;
  if (typeof id !== 'string') return res.status(400).json({ error: 'id is required' });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const repository = await updateGitRepository(id, parsed.data);
    return res.status(200).json({ repository });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update repository';
    return res.status(400).json({ error: message });
  }
}

async function deleteHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  const { id } = _req.query;
  if (typeof id !== 'string') return res.status(400).json({ error: 'id is required' });

  const result = await deleteGitRepository(id);
  return res.status(200).json({ ok: true, message: result.message });
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'PUT') return putHandler(req, res);
  if (req.method === 'DELETE') return deleteHandler(req, res);
  return methodNotAllowed(res, ['PUT', 'DELETE']);
}

export default requireAdmin(handler);

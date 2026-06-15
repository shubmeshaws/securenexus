import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { createGitRepository, listGitRepositoryViews } from '@/lib/git-repositories';
import { linkAppSourcesToRepositories } from '@/lib/git-repositories';
import { z } from 'zod';

const createSchema = z.object({
  workspace: z.string().min(1),
  repoUrl: z.string().min(1),
  defaultBranch: z.string().optional().nullable(),
  pullIntervalMin: z.coerce.number().int().min(1).max(525600).optional(),
  enabled: z.boolean().optional(),
});

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  const repositories = await listGitRepositoryViews();
  return res.status(200).json({ repositories });
}

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const repository = await createGitRepository({
      workspace: parsed.data.workspace,
      repoUrl: parsed.data.repoUrl,
      defaultBranch: parsed.data.defaultBranch,
      pullIntervalMin: parsed.data.pullIntervalMin,
      enabled: parsed.data.enabled,
    });

    await linkAppSourcesToRepositories();
    return res.status(201).json({ repository });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to add repository';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return postHandler(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

export default requireAdmin(handler);

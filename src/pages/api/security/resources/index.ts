import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  createSecurityResource,
  listSecurityResources,
} from '@/lib/security-service';
import { z } from 'zod';

const createSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('repository'),
    name: z.string().optional(),
    repoUrl: z.string().min(1),
    defaultBranch: z.string().optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('target_url'),
    name: z.string().optional(),
    targetUrl: z.string().min(1),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
]);

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    const resources = await listSecurityResources();
    return res.status(200).json({ resources });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load security resources';
    return res.status(500).json({ error: message });
  }
}

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const resource = await createSecurityResource({
      ...parsed.data,
      createdBy: req.user?.email,
    });
    return res.status(201).json({ resource });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create security resource';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return postHandler(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

export default requireAdmin(handler);

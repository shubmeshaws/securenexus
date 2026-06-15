import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  disconnectBitbucket,
  getBitbucketConnectionView,
  upsertBitbucketConnection,
  SECRET_PLACEHOLDER,
} from '@/lib/bitbucket-connection';
import { z } from 'zod';

const upsertSchema = z.object({
  username: z.string().optional(),
  token: z.string().optional(),
  workspace: z.string().optional().nullable(),
  tokenType: z.enum(['user_api', 'workspace_access']).optional(),
});

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  const connection = await getBitbucketConnectionView();
  return res.status(200).json({ connection });
}

async function putHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const connection = await upsertBitbucketConnection({
    username: parsed.data.username ?? '',
    token: parsed.data.token,
    tokenType: parsed.data.tokenType,
    workspace: parsed.data.workspace,
    status: parsed.data.token && parsed.data.token !== SECRET_PLACEHOLDER ? 'disconnected' : undefined,
  });
  return res.status(200).json({ connection });
}

async function deleteHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  await disconnectBitbucket();
  return res.status(200).json({ ok: true });
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'PUT') return putHandler(req, res);
  if (req.method === 'DELETE') return deleteHandler(req, res);
  return methodNotAllowed(res, ['GET', 'PUT', 'DELETE']);
}

export default requireAdmin(handler);

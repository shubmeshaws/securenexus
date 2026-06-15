import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  deleteAwsCredential,
  getAwsCredentialView,
  updateAwsCredential,
  SECRET_PLACEHOLDER,
} from '@/lib/aws-credential-store';
import { z } from 'zod';

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  accessKeyId: z.string().min(1).max(128).optional(),
  secretAccessKey: z.string().optional(),
  defaultRegion: z.string().min(1).max(32).optional(),
  iamRoleName: z.string().max(256).nullable().optional(),
});

async function getHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = req.query.id as string;
  const credential = await getAwsCredentialView(id);
  if (!credential) return res.status(404).json({ error: 'AWS credential not found' });
  return res.status(200).json({ credential });
}

async function patchHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = req.query.id as string;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await getAwsCredentialView(id);
  if (!existing) return res.status(404).json({ error: 'AWS credential not found' });

  if (
    parsed.data.secretAccessKey !== undefined &&
    parsed.data.secretAccessKey !== SECRET_PLACEHOLDER &&
    !parsed.data.secretAccessKey.trim() &&
    !existing.secretAccessKeySet
  ) {
    return res.status(400).json({ error: 'AWS secret access key is required' });
  }

  try {
    const credential = await updateAwsCredential(id, parsed.data, req.user?.email);
    return res.status(200).json({ credential });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update AWS credential';
    return res.status(400).json({ error: message });
  }
}

async function deleteHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = req.query.id as string;
  const existing = await getAwsCredentialView(id);
  if (!existing) return res.status(404).json({ error: 'AWS credential not found' });

  try {
    await deleteAwsCredential(id);
    return res.status(200).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete AWS credential';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'PATCH') return patchHandler(req, res);
  if (req.method === 'DELETE') return deleteHandler(req, res);
  return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
}

export default requireAdmin(handler);

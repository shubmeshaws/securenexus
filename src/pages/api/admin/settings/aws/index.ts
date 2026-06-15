import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { getAwsSettingsView, saveAwsCredentials, clearAwsCredentials, SECRET_PLACEHOLDER } from '@/lib/aws-settings';
import { z } from 'zod';

const updateSchema = z.object({
  accessKeyId: z.string().min(1).max(128),
  secretAccessKey: z.string().optional(),
  defaultRegion: z.string().min(1).max(32),
});

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  const settings = await getAwsSettingsView();
  return res.status(200).json({ settings });
}

async function putHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await getAwsSettingsView();
  if (
    !parsed.data.secretAccessKey?.trim() &&
    parsed.data.secretAccessKey !== SECRET_PLACEHOLDER &&
    !existing.secretAccessKeySet
  ) {
    return res.status(400).json({ error: 'AWS secret access key is required' });
  }

  try {
    const settings = await saveAwsCredentials(parsed.data, req.user?.email);
    return res.status(200).json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save AWS credentials';
    return res.status(400).json({ error: message });
  }
}

async function deleteHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    const settings = await clearAwsCredentials();
    return res.status(200).json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to remove AWS credentials';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'PUT') return putHandler(req, res);
  if (req.method === 'DELETE') return deleteHandler(req, res);
  return methodNotAllowed(res, ['GET', 'PUT', 'DELETE']);
}

export default requireAdmin(handler);

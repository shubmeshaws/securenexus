import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  createAwsCredential,
  listAwsCredentials,
  SECRET_PLACEHOLDER,
} from '@/lib/aws-credential-store';
import { z } from 'zod';

const createSchema = z.object({
  name: z.string().min(1).max(80),
  accessKeyId: z.string().min(1).max(128),
  secretAccessKey: z.string().min(1),
  defaultRegion: z.string().min(1).max(32),
  iamRoleName: z.string().max(256).nullable().optional(),
});

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  const credentials = await listAwsCredentials();
  return res.status(200).json({ credentials });
}

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const credential = await createAwsCredential(parsed.data, req.user?.email);
    return res.status(201).json({ credential });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create AWS credential';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return postHandler(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

export default requireAdmin(handler);

export { SECRET_PLACEHOLDER };

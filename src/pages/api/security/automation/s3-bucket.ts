import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { ensureSecurityS3Bucket } from '@/lib/security-s3-bucket';

const bodySchema = z.object({
  awsCredentialId: z.string().min(1),
  bucket: z.string().min(1),
  region: z.string().optional(),
});

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const result = await ensureSecurityS3Bucket(parsed.data);
    return res.status(200).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create S3 bucket';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'POST') return postHandler(req, res);
  return methodNotAllowed(res, ['POST']);
}

export default requireAdmin(handler);

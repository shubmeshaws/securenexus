import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  getAwsCredentialView,
  resolveAwsCredentialsForInput,
  testAwsCredentialConnection,
} from '@/lib/aws-credential-store';
import { z } from 'zod';

const testSchema = z.object({
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  defaultRegion: z.string().optional(),
  iamRoleName: z.string().nullable().optional(),
  name: z.string().optional(),
});

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = req.query.id as string;
  const parsed = testSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const credentials = await resolveAwsCredentialsForInput(id, parsed.data);
  if (!credentials) {
    return res.status(400).json({ ok: false, message: 'AWS credentials are incomplete' });
  }

  const row = await getAwsCredentialView(id);
  const iamRoleName =
    parsed.data.iamRoleName !== undefined ? parsed.data.iamRoleName : row?.iamRoleName;

  const result = await testAwsCredentialConnection(credentials, {
    iamRoleName,
    awsAccountId: row?.awsAccountId,
    sessionLabel: `SecureNexus-${parsed.data.name ?? row?.name ?? 'test'}`,
  });
  return res.status(200).json(result);
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'POST') return postHandler(req, res);
  return methodNotAllowed(res, ['POST']);
}

export default requireAdmin(handler);

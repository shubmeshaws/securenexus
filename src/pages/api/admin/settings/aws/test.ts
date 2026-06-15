import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  resolveAwsCredentialsForTest,
  testAwsCredentials,
} from '@/lib/aws-settings';
import { testAwsCredentialConnection } from '@/lib/aws-credential-store';
import { z } from 'zod';

const testSchema = z.object({
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  defaultRegion: z.string().optional(),
  iamRoleName: z.string().nullable().optional(),
  name: z.string().optional(),
});

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const parsed = testSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const credentials = await resolveAwsCredentialsForTest(parsed.data);
  if (!credentials) {
    return res.status(200).json({
      ok: false,
      message: 'Access key ID and secret access key are required',
    });
  }

  const result = parsed.data.iamRoleName?.trim()
    ? await testAwsCredentialConnection(credentials, {
        iamRoleName: parsed.data.iamRoleName,
        sessionLabel: `SecureNexus-${parsed.data.name ?? 'test'}`,
      })
    : await testAwsCredentials(credentials);
  return res.status(200).json(result);
}

export default requireAdmin(handler);

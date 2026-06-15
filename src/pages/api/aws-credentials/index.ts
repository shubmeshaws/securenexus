import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { listAwsCredentials, listEc2InstancesForCredential } from '@/lib/aws-credential-store';

async function listHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  const credentials = await listAwsCredentials();
  return res.status(200).json({
    credentials: credentials.map((c) => ({
      id: c.id,
      name: c.name,
      defaultRegion: c.defaultRegion,
      awsAccountId: c.awsAccountId,
      iamUsername: c.iamUsername,
      iamRoleName: c.iamRoleName,
      secretAccessKeySet: c.secretAccessKeySet,
    })),
  });
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return listHandler(req, res);
  return methodNotAllowed(res, ['GET']);
}

export default requireAuth(handler);

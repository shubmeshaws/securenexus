import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  getBitbucketCredentials,
  markBitbucketConnectionTested,
  upsertBitbucketConnection,
  SECRET_PLACEHOLDER,
} from '@/lib/bitbucket-connection';
import { testBitbucketConnection } from '@/lib/bitbucket-client';
import { z } from 'zod';

const testSchema = z.object({
  username: z.string().optional(),
  token: z.string().optional(),
  workspace: z.string().optional().nullable(),
  tokenType: z.enum(['user_api', 'workspace_access']).optional(),
});

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const parsed = testSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await getBitbucketCredentials();
  let token = parsed.data.token?.trim().replace(/\s+/g, '') ?? '';
  if ((!token || token === SECRET_PLACEHOLDER) && existing) {
    token = existing.token;
  }

  const tokenType =
    parsed.data.tokenType ?? existing?.tokenType ?? ('user_api' as const);
  const username = parsed.data.username?.trim() ?? existing?.username ?? '';
  const workspace = parsed.data.workspace ?? existing?.workspace ?? null;

  if (!token) {
    return res.status(200).json({ ok: false, message: 'API token is required' });
  }

  if (tokenType === 'user_api' && !username) {
    return res.status(200).json({
      ok: false,
      message: 'Atlassian account email is required for user API tokens.',
    });
  }

  if (tokenType === 'workspace_access' && !workspace) {
    return res.status(200).json({
      ok: false,
      message: 'Workspace slug is required for workspace access tokens.',
    });
  }

  const result = await testBitbucketConnection({
    username: username || workspace || '',
    token,
    workspace,
    tokenType,
  });

  if (result.ok) {
    await upsertBitbucketConnection({
      username: tokenType === 'workspace_access' ? username || workspace || '' : username,
      authUsername: result.authUsername ?? null,
      token,
      tokenType: result.tokenType ?? tokenType,
      workspace,
      status: 'connected',
      lastError: null,
    });
    await markBitbucketConnectionTested(true);
  } else {
    await upsertBitbucketConnection({
      username: username || workspace || '',
      token: token || undefined,
      tokenType,
      workspace,
      status: 'error',
      lastError: result.message,
    });
    await markBitbucketConnectionTested(false, result.message);
  }

  return res.status(200).json(result);
}

export default requireAdmin(handler);

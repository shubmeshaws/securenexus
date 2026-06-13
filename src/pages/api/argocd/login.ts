import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed } from '@/lib/auth';
import argocdClient from '@/lib/argocd-client';
import { argocdLoginSchema } from '@/lib/validation';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const parsed = argocdLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const { token } = await argocdClient.login(parsed.data.username, parsed.data.password);
    return res.status(200).json({ token });
  } catch {
    return res.status(401).json({ error: 'ArgoCD login failed' });
  }
}

export default requireAuth(handler);

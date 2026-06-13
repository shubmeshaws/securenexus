import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { requireAuth, requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { KubeconfigFileError, readKubeconfigFromPath } from '@/lib/kubeconfig-file';
import prisma from '@/lib/prisma';

const bodySchema = z.object({
  path: z.string().min(1),
});

function buildRegisteredLookup(
  clusters: { name: string; contextName: string | null }[]
) {
  const byContext = new Map<string, string>();

  for (const cluster of clusters) {
    if (cluster.contextName) {
      byContext.set(cluster.contextName, cluster.name);
    }
    byContext.set(cluster.name, cluster.name);
  }

  return byContext;
}

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const result = readKubeconfigFromPath(parsed.data.path);
    const registered = await prisma.cluster.findMany({
      where: { provider: 'kubeconfig' },
      select: { name: true, contextName: true },
    });
    const registeredLookup = buildRegisteredLookup(registered);

    const contexts = result.contexts.map((ctx) => {
      const registeredName = registeredLookup.get(ctx.name) ?? null;
      return {
        ...ctx,
        alreadyAdded: Boolean(registeredName),
        registeredName,
      };
    });

    return res.status(200).json({
      resolvedPath: result.resolvedPath,
      contexts,
      currentContext: result.currentContext,
    });
  } catch (err) {
    if (err instanceof KubeconfigFileError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
}

function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'POST') return requireAdmin(postHandler)(req, res);
  return methodNotAllowed(res, ['POST']);
}

export default requireAuth(handler);

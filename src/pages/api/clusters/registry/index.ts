import type { NextApiResponse } from 'next';
import { requireAuth, requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { KubeconfigFileError, readKubeconfigFromPath } from '@/lib/kubeconfig-file';
import prisma from '@/lib/prisma';
import { invalidateKubeConfigCache } from '@/lib/k8s-client';
import { invalidateWorkloadCache } from '@/lib/workload-scan';
import { z } from 'zod';

const addClusterSchema = z
  .discriminatedUnion('provider', [
  z.object({
    name: z.string().min(1).max(100),
    provider: z.literal('kubeconfig'),
    contextName: z.string().optional(),
    kubeconfigB64: z.string().min(1).optional(),
    kubeconfigPath: z.string().min(1).optional(),
  }),
  z.object({
    name: z.string().min(1).max(100),
    provider: z.literal('aws'),
    awsAccessKeyId: z.string().min(1),
    awsSecretKey: z.string().min(1),
    awsRegion: z.string().min(1),
    awsClusterName: z.string().min(1),
  }),
])
  .superRefine((data, ctx) => {
    if (data.provider === 'kubeconfig' && !data.kubeconfigB64 && !data.kubeconfigPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide a kubeconfig file upload or a local kubeconfig path',
        path: ['kubeconfigPath'],
      });
    }
  });

function sanitizeCluster(c: Record<string, unknown>) {
  const { kubeconfigB64, awsSecretKey, awsAccessKeyId, ...safe } = c;
  return safe;
}

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  const clusters = await prisma.cluster.findMany({ orderBy: { createdAt: 'desc' } });
  return res.status(200).json({
    clusters: clusters.map(sanitizeCluster),
    total: clusters.length,
  });
}

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = addClusterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const data = parsed.data;

  let kubeconfigB64: string | undefined;
  let kubeconfigPath: string | undefined;

  let serverUrl: string | undefined;

  if (data.provider === 'kubeconfig') {
    const contextName = data.contextName ?? data.name;

    const existing = await prisma.cluster.findFirst({
      where: {
        provider: 'kubeconfig',
        OR: [{ contextName }, { name: contextName }, { name: data.name }],
      },
    });
    if (existing) {
      return res.status(409).json({
        error: `Cluster "${existing.name}" is already added`,
        cluster: sanitizeCluster(existing as unknown as Record<string, unknown>),
      });
    }

    try {
      if (data.kubeconfigPath) {
        const loaded = readKubeconfigFromPath(data.kubeconfigPath);
        kubeconfigB64 = loaded.kubeconfigB64;
        kubeconfigPath = loaded.resolvedPath;
        const match = loaded.contexts.find((ctx) => ctx.name === contextName);
        serverUrl = match?.server ?? undefined;
      } else {
        kubeconfigB64 = data.kubeconfigB64;
      }
    } catch (err) {
      if (err instanceof KubeconfigFileError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  }

  const cluster = await prisma.cluster.create({
    data: {
      name: data.name,
      provider: data.provider,
      addedBy: req.user?.id,
      addedByName: req.user?.email,
      status: 'connected',
      lastSyncAt: new Date(),
      ...(data.provider === 'kubeconfig'
        ? {
            contextName: data.contextName ?? data.name,
            kubeconfigB64,
            kubeconfigPath,
            serverUrl: serverUrl ?? 'configured',
          }
        : {
            awsAccessKeyId: data.awsAccessKeyId,
            awsSecretKey: data.awsSecretKey,
            region: data.awsRegion,
            awsClusterName: data.awsClusterName,
          }),
    },
  });

  invalidateKubeConfigCache();
  invalidateWorkloadCache();

  return res.status(201).json({ cluster: sanitizeCluster(cluster as unknown as Record<string, unknown>) });
}

function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return requireAdmin(postHandler)(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

export default requireAuth(handler);

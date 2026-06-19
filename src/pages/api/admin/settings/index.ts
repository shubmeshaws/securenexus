import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { getAdminSettings, updateAdminSettings } from '@/lib/settings';
import { invalidateKubeConfigCache } from '@/lib/k8s-client';
import { invalidateWorkloadCache } from '@/lib/workload-scan';
import { pruneResourceAuditDataByRetention } from '@/lib/resource-audit-retention';
import { pruneActivityLogsByRetention } from '@/lib/activity';
import { pruneNodeSamplesByRetention, pruneNodeSamplesBeforeCaptureStart } from '@/lib/node-sample-retention';
import { invalidateNodeChangesCache } from '@/lib/node-changes-service';
import { invalidatePodChangesCache } from '@/lib/pod-changes-service';
import { z } from 'zod';

const updateSchema = z.object({
  argocdServer: z.string().optional(),
  argocdToken: z.string().optional(),
  argocdInsecureTls: z.boolean().optional(),
  kubeconfigBase64: z.string().optional(),
  googleAllowedDomain: z.string().optional(),
  newUserAccessEnabled: z.boolean().optional(),
  demoMode: z.boolean().optional(),
  redisUrl: z.string().optional(),
  apiBaseUrl: z.string().optional(),
  activityLogRetentionDays: z.number().int().min(1).max(3650).optional(),
  nodeSampleRetentionDays: z.number().int().min(7).max(3650).optional(),
  nodeSampleDataStartDate: z.string().optional(),
  nodeSampleDataStartTime: z.string().optional(),
  resourceAuditRetentionAmount: z.number().int().min(1).max(52).optional(),
  resourceAuditRetentionUnit: z.enum(['weeks', 'months', 'years']).optional(),
  resourceAuditDataStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  securityModuleEnabled: z.boolean().optional(),
});

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  const settings = await getAdminSettings();
  return res.status(200).json({ settings });
}

async function putHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const retentionTouched =
    parsed.data.resourceAuditRetentionAmount !== undefined ||
    parsed.data.resourceAuditRetentionUnit !== undefined ||
    parsed.data.resourceAuditDataStartDate !== undefined;
  const activityRetentionTouched = parsed.data.activityLogRetentionDays !== undefined;
  const nodeSampleRetentionTouched = parsed.data.nodeSampleRetentionDays !== undefined;
  const nodeSampleStartTouched =
    parsed.data.nodeSampleDataStartDate !== undefined ||
    parsed.data.nodeSampleDataStartTime !== undefined;

  let settings;
  try {
    settings = await updateAdminSettings(parsed.data, req.user?.email);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid settings';
    return res.status(400).json({ error: message });
  }

  if (retentionTouched) {
    const pruned = await pruneResourceAuditDataByRetention();
    if (pruned.auditDeleted > 0 || pruned.gitDeleted > 0) {
      console.log(
        `[ResourceAudit] Retention prune: ${pruned.auditDeleted} audit rows, ${pruned.gitDeleted} git rows removed`
      );
    }
  }

  if (activityRetentionTouched) {
    await pruneActivityLogsByRetention();
  }

  if (nodeSampleRetentionTouched) {
    const deleted = await pruneNodeSamplesByRetention();
    invalidateNodeChangesCache();
    invalidatePodChangesCache();
    if (deleted > 0) {
      console.log(`[NodeCount] Retention prune: ${deleted} hourly samples removed`);
    }
  }

  if (nodeSampleStartTouched) {
    const deleted = await pruneNodeSamplesBeforeCaptureStart();
    invalidateNodeChangesCache();
    invalidatePodChangesCache();
    if (deleted > 0) {
      console.log(`[NodeCount] Capture start prune: ${deleted} hourly samples removed`);
    }
  }

  invalidateKubeConfigCache();
  invalidateWorkloadCache();
  return res.status(200).json({ settings });
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'PUT') return putHandler(req, res);
  return methodNotAllowed(res, ['GET', 'PUT']);
}

export default requireAdmin(handler);

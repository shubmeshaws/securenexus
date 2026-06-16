import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { refreshGitResourceAuditRows } from '@/lib/git-resource-audit-join';
import { linkAppSourcesToRepositories } from '@/lib/git-repositories';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  await linkAppSourcesToRepositories().catch(() => 0);

  const [gitChanges, unlinkedBefore, auditBefore] = await Promise.all([
    prisma.gitResourceChange.count({ where: { resourceType: { not: 'FILE_TOUCH' } } }),
    prisma.gitResourceChange.count({
      where: { auditLinked: false, resourceType: { not: 'FILE_TOUCH' } },
    }),
    prisma.resourceChangeAudit.count({ where: { resourceType: { not: 'GIT_SYNC' } } }),
  ]);

  const result = await refreshGitResourceAuditRows();

  const [auditAfter, unlinkedAfter] = await Promise.all([
    prisma.resourceChangeAudit.count({ where: { resourceType: { not: 'GIT_SYNC' } } }),
    prisma.gitResourceChange.count({
      where: { auditLinked: false, resourceType: { not: 'FILE_TOUCH' } },
    }),
  ]);

  return res.status(200).json({
    ok: true,
    message: `Rebuild complete — ${result.linked} row(s) linked from git history`,
    gitChanges,
    unlinkedBefore,
    auditBefore,
    auditAfter,
    unlinkedAfter,
    deleted: result.deleted,
    gitSyncRemoved: result.gitSyncRemoved,
  });
}

export default requireAdmin(handler);

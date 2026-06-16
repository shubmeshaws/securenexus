import prisma from './prisma';
import { refreshGitResourceAuditRows } from './git-resource-audit-join';
import { linkAppSourcesToRepositories } from './git-repositories';

export type ResourceAuditRebuildPhase =
  | 'idle'
  | 'linking_sources'
  | 'rebuilding'
  | 'done'
  | 'failed';

export interface ResourceAuditRebuildStatus {
  running: boolean;
  phase: ResourceAuditRebuildPhase;
  startedAt: string | null;
  finishedAt: string | null;
  gitChanges: number;
  unlinkedBefore: number;
  auditBefore: number;
  linked: number;
  auditAfter: number;
  unlinkedAfter: number;
  deleted: number;
  gitSyncRemoved: number;
  error: string | null;
  message: string | null;
}

const IDLE_STATUS: ResourceAuditRebuildStatus = {
  running: false,
  phase: 'idle',
  startedAt: null,
  finishedAt: null,
  gitChanges: 0,
  unlinkedBefore: 0,
  auditBefore: 0,
  linked: 0,
  auditAfter: 0,
  unlinkedAfter: 0,
  deleted: 0,
  gitSyncRemoved: 0,
  error: null,
  message: null,
};

let rebuildStatus: ResourceAuditRebuildStatus = { ...IDLE_STATUS };

export function getResourceAuditRebuildStatus(): ResourceAuditRebuildStatus {
  return rebuildStatus;
}

export function startResourceAuditRebuild(): 'started' | 'already_running' {
  if (rebuildStatus.running) return 'already_running';

  rebuildStatus = {
    ...IDLE_STATUS,
    running: true,
    phase: 'linking_sources',
    startedAt: new Date().toISOString(),
    message: 'Linking ArgoCD app sources to git repositories…',
  };

  void (async () => {
    try {
      await linkAppSourcesToRepositories().catch(() => 0);

      const [gitChanges, unlinkedBefore, auditBefore] = await Promise.all([
        prisma.gitResourceChange.count({ where: { resourceType: { not: 'FILE_TOUCH' } } }),
        prisma.gitResourceChange.count({
          where: { auditLinked: false, resourceType: { not: 'FILE_TOUCH' } },
        }),
        prisma.resourceChangeAudit.count({ where: { resourceType: { not: 'GIT_SYNC' } } }),
      ]);

      rebuildStatus = {
        ...rebuildStatus,
        gitChanges,
        unlinkedBefore,
        auditBefore,
        phase: 'rebuilding',
        message: `Rebuilding from ${gitChanges} git change(s)…`,
      };

      const result = await refreshGitResourceAuditRows((linkedSoFar, unlinkedRemaining) => {
        rebuildStatus = {
          ...rebuildStatus,
          linked: linkedSoFar,
          unlinkedAfter: unlinkedRemaining,
          message: `Linked ${linkedSoFar} row(s) — ${unlinkedRemaining} git change(s) remaining…`,
        };
      });

      const [auditAfter, unlinkedAfter] = await Promise.all([
        prisma.resourceChangeAudit.count({ where: { resourceType: { not: 'GIT_SYNC' } } }),
        prisma.gitResourceChange.count({
          where: { auditLinked: false, resourceType: { not: 'FILE_TOUCH' } },
        }),
      ]);

      rebuildStatus = {
        running: false,
        phase: 'done',
        startedAt: rebuildStatus.startedAt,
        finishedAt: new Date().toISOString(),
        gitChanges,
        unlinkedBefore,
        auditBefore,
        linked: result.linked,
        auditAfter,
        unlinkedAfter,
        deleted: result.deleted,
        gitSyncRemoved: result.gitSyncRemoved,
        error: null,
        message: `Rebuild complete — ${result.linked} row(s) linked (${auditBefore} → ${auditAfter} audit rows)`,
      };

      console.log('[ResourceAudit] Background rebuild complete:', rebuildStatus.message);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Rebuild failed';
      rebuildStatus = {
        ...rebuildStatus,
        running: false,
        phase: 'failed',
        finishedAt: new Date().toISOString(),
        error: message,
        message,
      };
      console.error('[ResourceAudit] Background rebuild failed:', err);
    }
  })();

  return 'started';
}

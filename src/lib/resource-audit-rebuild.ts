import prisma from './prisma';
import { linkUnlinkedGitChangesIncremental } from './git-resource-audit-join';
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
        auditAfter: auditBefore,
        phase: 'rebuilding',
        message:
          unlinkedBefore > 0
            ? `Linking ${unlinkedBefore} git change(s) — newest commits first…`
            : 'No pending git changes to link',
      };

      if (unlinkedBefore === 0) {
        rebuildStatus = {
          ...rebuildStatus,
          running: false,
          phase: 'done',
          finishedAt: new Date().toISOString(),
          message: `Already up to date (${auditBefore} audit row(s))`,
        };
        return;
      }

      const result = await linkUnlinkedGitChangesIncremental(
        async (linkedSoFar, unlinkedRemaining, auditRowCount) => {
          rebuildStatus = {
            ...rebuildStatus,
            linked: linkedSoFar,
            auditAfter: auditRowCount,
            unlinkedAfter: unlinkedRemaining,
            message: `${auditRowCount} row(s) visible — linked ${linkedSoFar}, ${unlinkedRemaining} pending…`,
          };
        }
      );

      const unlinkedAfter = await prisma.gitResourceChange.count({
        where: { auditLinked: false, resourceType: { not: 'FILE_TOUCH' } },
      });

      rebuildStatus = {
        running: false,
        phase: 'done',
        startedAt: rebuildStatus.startedAt,
        finishedAt: new Date().toISOString(),
        gitChanges,
        unlinkedBefore,
        auditBefore,
        linked: result.linked,
        auditAfter: rebuildStatus.auditAfter,
        unlinkedAfter,
        deleted: 0,
        gitSyncRemoved: 0,
        error: null,
        message: `Rebuild complete — ${rebuildStatus.auditAfter} row(s) visible (${result.linked} linked from git)`,
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

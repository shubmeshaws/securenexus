import cron from 'node-cron';
import prisma from './prisma';
import {
  automationScheduleRowFromRecord,
  computeAutomationNextRun,
  matchesAutomationScheduleMinute,
  startOfAutomationMinute,
} from './security-automation-schedule';
import {
  createSecurityScanJob,
  executeSecurityScanJob,
} from './security-scan-job-service';
import { uploadAutomationReportsToS3 } from './security-automation-s3-upload';
import { assertSecurityModuleEnabled } from './security-service';

const RUNNER_GLOBAL_KEY = '__secureNexusSecurityAutomationRunnerStarted__';

let tickJob: ReturnType<typeof cron.schedule> | null = null;
const automationExecutionInFlight = new Set<string>();
const AUTOMATION_CATCHUP_MS = 30 * 60 * 1000;

function shouldExecuteAutomation(
  automation: {
    nextRunAt: Date | null;
    lastRunAt: Date | null;
  },
  schedule: ReturnType<typeof automationScheduleRowFromRecord>,
  now: Date
): boolean {
  if (matchesAutomationScheduleMinute(schedule, now)) return true;
  if (!automation.nextRunAt || automation.nextRunAt > now) return false;
  if (now.getTime() - automation.nextRunAt.getTime() > AUTOMATION_CATCHUP_MS) return false;
  if (automation.lastRunAt && automation.lastRunAt >= automation.nextRunAt) return false;
  return true;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

async function deliverAutomationResults(
  automation: {
    id: string;
    name: string;
    s3Enabled: boolean;
    s3Bucket: string | null;
    s3Region: string | null;
    s3Prefix: string | null;
    awsCredentialId: string | null;
  },
  jobId: string,
  completedAt: Date
): Promise<string | null> {
  if (!automation.s3Enabled) return null;

  try {
    if (!automation.s3Bucket?.trim() || !automation.awsCredentialId) {
      throw new Error('S3 bucket or AWS credentials are not configured');
    }

    const result = await uploadAutomationReportsToS3({
      automationName: automation.name,
      s3Bucket: automation.s3Bucket,
      s3Region: automation.s3Region,
      s3Prefix: automation.s3Prefix,
      awsCredentialId: automation.awsCredentialId,
      scanJobId: jobId,
      completedAt,
    });

    console.log(
      `[SecurityAutomation] Uploaded ${result.uploaded} file(s) to s3://${automation.s3Bucket}/${result.keys[0]?.split('/').slice(0, -1).join('/') ?? ''}`
    );
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'S3 upload failed';
    console.error(`[SecurityAutomation] S3 upload failed for ${automation.id}:`, err);
    return message;
  }
}

async function finalizeAutomationRun(
  automationId: string,
  status: 'completed' | 'failed',
  error: string | null
): Promise<void> {
  const automation = await prisma.securityAutomation.findUnique({ where: { id: automationId } });
  if (!automation) return;

  const schedule = automationScheduleRowFromRecord(automation);
  const now = new Date();
  const nextRunAt = status === 'completed' && schedule.scheduleFrequency === 'once'
    ? null
    : computeAutomationNextRun(schedule, now);

  await prisma.securityAutomation.update({
    where: { id: automationId },
    data: {
      lastRunStatus: status,
      lastRunError: error,
      activeScanJobId: null,
      lastRunAt: now,
      nextRunAt,
      ...(schedule.scheduleFrequency === 'once' && status === 'completed'
        ? { enabled: false }
        : {}),
    },
  });
}

async function syncAutomationFromScanJob(automationId: string, jobId: string): Promise<void> {
  const automation = await prisma.securityAutomation.findUnique({ where: { id: automationId } });
  const job = await prisma.securityScanJob.findUnique({ where: { id: jobId } });
  if (!job) {
    await prisma.securityAutomation.update({
      where: { id: automationId },
      data: { activeScanJobId: null, lastRunStatus: 'failed', lastRunError: 'Scan job not found' },
    });
    return;
  }

  if (job.status === 'queued' || job.status === 'running') return;

  let deliveryError: string | null = null;
  if (job.status === 'completed' && automation) {
    deliveryError = await deliverAutomationResults(
      automation,
      jobId,
      job.completedAt ?? new Date()
    );
  }

  const combinedError =
    [job.error, deliveryError].filter((value): value is string => Boolean(value)).join(' · ') || null;

  await finalizeAutomationRun(
    automationId,
    job.status === 'completed' ? 'completed' : 'failed',
    combinedError
  );
}

async function executeAutomation(automationId: string): Promise<void> {
  if (automationExecutionInFlight.has(automationId)) return;
  automationExecutionInFlight.add(automationId);

  try {
    const automation = await prisma.securityAutomation.findUnique({ where: { id: automationId } });
    if (!automation || !automation.enabled) return;

    const resourceIds = parseStringArray(automation.resourceIds);
    const toolIds = parseStringArray(automation.toolIds);
    if (!resourceIds.length || !toolIds.length) {
      await finalizeAutomationRun(automationId, 'failed', 'Automation has no targets or tools configured');
      return;
    }

    const job = await createSecurityScanJob({
      resourceIds,
      toolIds,
      reportMode: automation.reportMode === 'merged' ? 'merged' : 'separate',
      createdBy: `automation:${automation.name}`,
    });

    await prisma.securityAutomation.update({
      where: { id: automationId },
      data: {
        activeScanJobId: job.id,
        lastRunStatus: 'running',
        lastRunError: null,
      },
    });

    await executeSecurityScanJob(job.id);

    const finished = await prisma.securityScanJob.findUnique({ where: { id: job.id } });
    const scanStatus = finished?.status === 'completed' ? 'completed' : 'failed';
    let deliveryError: string | null = null;

    if (scanStatus === 'completed') {
      deliveryError = await deliverAutomationResults(
        automation,
        job.id,
        finished?.completedAt ?? new Date()
      );
    }

    const combinedError =
      [finished?.error, deliveryError].filter((value): value is string => Boolean(value)).join(' · ') ||
      null;

    await finalizeAutomationRun(automationId, scanStatus, combinedError);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Automation run failed';
    await finalizeAutomationRun(automationId, 'failed', message);
    console.error(`[SecurityAutomation] Run failed for ${automationId}:`, err);
  } finally {
    automationExecutionInFlight.delete(automationId);
  }
}

async function tryClaimAutomationRun(
  automationId: string,
  timezone: string,
  now: Date
): Promise<boolean> {
  const minuteStart = startOfAutomationMinute(now, timezone);
  const claim = await prisma.securityAutomation.updateMany({
    where: {
      id: automationId,
      enabled: true,
      activeScanJobId: null,
      OR: [{ lastRunAt: null }, { lastRunAt: { lt: minuteStart } }],
    },
    data: { lastRunAt: now },
  });
  return claim.count > 0;
}

async function tickSecurityAutomations(): Promise<void> {
  try {
    await assertSecurityModuleEnabled();
  } catch {
    return;
  }

  const now = new Date();
  const automations = await prisma.securityAutomation.findMany({
    where: { enabled: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const automation of automations) {
    if (automation.activeScanJobId) {
      await syncAutomationFromScanJob(automation.id, automation.activeScanJobId);
      continue;
    }

    const schedule = automationScheduleRowFromRecord(automation);
    if (!shouldExecuteAutomation(automation, schedule, now)) continue;
    if (automationExecutionInFlight.has(automation.id)) continue;

    const claimed = await tryClaimAutomationRun(
      automation.id,
      schedule.timezone || 'UTC',
      now
    );
    if (!claimed) continue;

    void executeAutomation(automation.id);
  }
}

export async function reloadAllAutomationNextRuns(): Promise<number> {
  const automations = await prisma.securityAutomation.findMany();
  let updated = 0;

  for (const automation of automations) {
    const schedule = automationScheduleRowFromRecord(automation);
    const nextRunAt = computeAutomationNextRun(schedule, new Date());
    const nextIso = nextRunAt?.toISOString() ?? null;
    const currentIso = automation.nextRunAt?.toISOString() ?? null;
    if (nextIso === currentIso) continue;

    await prisma.securityAutomation.update({
      where: { id: automation.id },
      data: { nextRunAt },
    });
    updated += 1;
  }

  return updated;
}

export async function recoverInFlightAutomations(): Promise<void> {
  const automations = await prisma.securityAutomation.findMany({
    where: { activeScanJobId: { not: null } },
  });

  for (const automation of automations) {
    if (!automation.activeScanJobId) continue;
    const job = await prisma.securityScanJob.findUnique({
      where: { id: automation.activeScanJobId },
    });
    if (!job || job.status === 'queued' || job.status === 'running') {
      if (job) {
        void executeSecurityScanJob(job.id).then(() =>
          syncAutomationFromScanJob(automation.id, job.id)
        );
      }
      continue;
    }
    await syncAutomationFromScanJob(automation.id, automation.activeScanJobId);
  }
}

export function initSecurityAutomationRunner() {
  const g = globalThis as typeof globalThis & { [RUNNER_GLOBAL_KEY]?: boolean };
  if (g[RUNNER_GLOBAL_KEY] || tickJob) return;

  g[RUNNER_GLOBAL_KEY] = true;
  console.log('[SecurityAutomation] Initializing automation runner (every minute)...');

  tickJob = cron.schedule('* * * * *', async () => {
    try {
      await tickSecurityAutomations();
    } catch (err) {
      console.error('[SecurityAutomation] Tick error:', err);
    }
  });

  reloadAllAutomationNextRuns()
    .then((count) => {
      if (count > 0) {
        console.log(`[SecurityAutomation] Refreshed next run for ${count} automation(s)`);
      }
    })
    .catch((err) => {
      console.error('[SecurityAutomation] Failed to refresh next runs:', err);
    });

  recoverInFlightAutomations().catch((err) => {
    console.error('[SecurityAutomation] Failed to recover in-flight runs:', err);
  });
}

export function ensureSecurityAutomationRunner() {
  initSecurityAutomationRunner();
}

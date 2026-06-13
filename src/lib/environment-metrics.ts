import prisma from '@/lib/prisma';

const GLOBAL_ID = 'global';

export type EnvironmentState = 'running' | 'stopped';

export interface EnvironmentHoursSummary {
  state: EnvironmentState;
  stateSince: string;
  runningHours: number;
  stoppedHours: number;
}

function msToHours(ms: number): number {
  return Math.round((ms / 3_600_000) * 10) / 10;
}

async function ensureMetrics() {
  return prisma.environmentMetrics.upsert({
    where: { id: GLOBAL_ID },
    create: { id: GLOBAL_ID, state: 'running', stateSince: new Date() },
    update: {},
  });
}

export async function getEnvironmentHours(): Promise<EnvironmentHoursSummary> {
  const row = await ensureMetrics();
  const now = Date.now();
  const elapsed = now - row.stateSince.getTime();

  let runningMs = Number(row.totalRunningMs);
  let stoppedMs = Number(row.totalStoppedMs);

  if (row.state === 'running') runningMs += elapsed;
  else stoppedMs += elapsed;

  return {
    state: row.state as EnvironmentState,
    stateSince: row.stateSince.toISOString(),
    runningHours: msToHours(runningMs),
    stoppedHours: msToHours(stoppedMs),
  };
}

export async function setEnvironmentState(state: EnvironmentState): Promise<void> {
  const row = await ensureMetrics();
  if (row.state === state) return;

  const now = new Date();
  const elapsed = BigInt(now.getTime() - row.stateSince.getTime());

  await prisma.environmentMetrics.update({
    where: { id: GLOBAL_ID },
    data: {
      state,
      stateSince: now,
      totalRunningMs:
        row.state === 'running' ? row.totalRunningMs + elapsed : row.totalRunningMs,
      totalStoppedMs:
        row.state === 'stopped' ? row.totalStoppedMs + elapsed : row.totalStoppedMs,
    },
  });
}

import { appendFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { randomBytes } from 'crypto';
import type { Schedule } from '@prisma/client';
import { isNamespaceSchedule } from './workload-utils';

export type ScheduleRunMode = 'shutdown' | 'startup';

export interface ScheduleRunLogContext {
  runId: string;
  mode: ScheduleRunMode;
  scheduleId: string;
  scheduleName: string;
  triggeredBy: string;
  cluster: string;
  namespace: string;
  appName: string;
  scope: 'namespace' | 'workload';
  workloadKind: string | null;
  platformType: string | null;
}

export interface ScheduleRunLogger {
  ctx: ScheduleRunLogContext;
  phase(phase: string, message: string, data?: Record<string, unknown>): void;
  warn(phase: string, message: string, data?: Record<string, unknown>): void;
  error(phase: string, message: string, data?: Record<string, unknown>): void;
  finish(
    status: 'success' | 'failed',
    message: string,
    data?: Record<string, unknown>
  ): void;
}

const LOG_PREFIX = '[ScheduleRun]';

function scheduleRunLoggingEnabled(): boolean {
  return process.env.SCHEDULE_RUN_LOG !== '0';
}

function scheduleRunFilePath(): string | null {
  if (!scheduleRunLoggingEnabled()) return null;
  const fromEnv = process.env.SCHEDULE_RUN_LOG_FILE?.trim();
  if (fromEnv) return resolve(fromEnv);
  // Default: file in dev/local; opt-in on production via SCHEDULE_RUN_LOG=1 or SCHEDULE_RUN_LOG_FILE.
  if (process.env.SCHEDULE_RUN_LOG === '1' || process.env.NODE_ENV !== 'production') {
    return resolve(process.cwd(), 'logs', 'schedule-runs.log');
  }
  return null;
}

function jsonLogFormatEnabled(): boolean {
  return process.env.SCHEDULE_RUN_LOG_JSON === '1';
}

function buildContext(
  mode: ScheduleRunMode,
  schedule: Schedule,
  triggeredBy: string
): ScheduleRunLogContext {
  return {
    runId: randomBytes(4).toString('hex'),
    mode,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    triggeredBy,
    cluster: schedule.cluster,
    namespace: schedule.namespace,
    appName: schedule.appName,
    scope: isNamespaceSchedule(schedule) ? 'namespace' : 'workload',
    workloadKind: schedule.workloadKind ?? null,
    platformType: schedule.platformType ?? null,
  };
}

function formatLine(
  level: 'info' | 'warn' | 'error',
  ctx: ScheduleRunLogContext,
  phase: string,
  message: string,
  data?: Record<string, unknown>,
  extra?: Record<string, unknown>
): string {
  const ts = new Date().toISOString();
  if (jsonLogFormatEnabled()) {
    return JSON.stringify({
      ts,
      level,
      prefix: LOG_PREFIX,
      phase,
      message,
      ...ctx,
      ...data,
      ...extra,
    });
  }

  const base =
    `${LOG_PREFIX} ${ts} ${level.toUpperCase()} run=${ctx.runId} ` +
    `${ctx.mode} phase=${phase} schedule="${ctx.scheduleName}" ` +
    `id=${ctx.scheduleId} cluster=${ctx.cluster} ns=${ctx.namespace} ` +
    `target=${ctx.appName} scope=${ctx.scope} by=${ctx.triggeredBy}`;

  const payload = data && Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
  const tail = extra && Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
  return `${base} — ${message}${payload}${tail}`;
}

let fileReady: Promise<void> | null = null;

async function ensureLogFile(filePath: string): Promise<void> {
  if (!fileReady) {
    fileReady = mkdir(dirname(filePath), { recursive: true }).then(() => undefined);
  }
  await fileReady;
}

function writeToFile(line: string): void {
  const filePath = scheduleRunFilePath();
  if (!filePath) return;

  void ensureLogFile(filePath)
    .then(() => appendFile(filePath, `${line}\n`, 'utf8'))
    .catch((err) => {
      console.error(
        `${LOG_PREFIX} failed to write schedule run log file:`,
        err instanceof Error ? err.message : err
      );
    });
}

function emit(
  level: 'info' | 'warn' | 'error',
  ctx: ScheduleRunLogContext,
  phase: string,
  message: string,
  data?: Record<string, unknown>,
  extra?: Record<string, unknown>
): void {
  if (!scheduleRunLoggingEnabled()) return;

  const line = formatLine(level, ctx, phase, message, data, extra);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  writeToFile(line);
}

/** Structured logger for schedule stop/start — visible in PM2 stdout and optional log file. */
export function createScheduleRunLogger(
  mode: ScheduleRunMode,
  schedule: Schedule,
  triggeredBy: string
): ScheduleRunLogger {
  const ctx = buildContext(mode, schedule, triggeredBy);
  const startedAt = Date.now();

  return {
    ctx,
    phase(phase, message, data) {
      emit('info', ctx, phase, message, data);
    },
    warn(phase, message, data) {
      emit('warn', ctx, phase, message, data);
    },
    error(phase, message, data) {
      emit('error', ctx, phase, message, data);
    },
    finish(status, message, data) {
      emit(status === 'failed' ? 'error' : 'info', ctx, 'done', message, data, {
        status,
        durationMs: Date.now() - startedAt,
      });
    },
  };
}

/** Where schedule run logs are written, if file logging is active. */
export function getScheduleRunLogFilePath(): string | null {
  return scheduleRunFilePath();
}

import type { SecurityToolSettingView } from '@/lib/security-service';
import { installSecurityToolRuntime } from '@/lib/security-service';
import type { ServerOsType } from './tool-install-specs';

export type ToolInstallJobResult = {
  message: string;
  tools: SecurityToolSettingView[];
  runtimeVersion: string | null;
};

export type ToolInstallJobState = {
  running: boolean;
  toolId: string | null;
  osType: ServerOsType | null;
  phase: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  result: ToolInstallJobResult | null;
  error: string | null;
};

let job: ToolInstallJobState = {
  running: false,
  toolId: null,
  osType: null,
  phase: null,
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
};

export function getToolInstallJob(): ToolInstallJobState {
  return job;
}

export function startToolInstallJob(
  toolId: string,
  osType: ServerOsType,
  enableAfter = true
): boolean {
  if (job.running) return false;

  job = {
    running: true,
    toolId,
    osType,
    phase: 'Starting installation…',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
  };

  void installSecurityToolRuntime(toolId, {
    osType,
    enableAfter,
    onProgress: (phase) => {
      if (job.running) {
        job = { ...job, phase };
      }
    },
  })
    .then((result) => {
      job = {
        ...job,
        running: false,
        finishedAt: new Date().toISOString(),
        phase: 'Installation complete',
        result: {
          message: result.message,
          tools: result.tools,
          runtimeVersion: result.runtimeVersion,
        },
        error: null,
      };
    })
    .catch((err) => {
      job = {
        ...job,
        running: false,
        finishedAt: new Date().toISOString(),
        phase: null,
        result: null,
        error: err instanceof Error ? err.message : 'Installation failed',
      };
    });

  return true;
}

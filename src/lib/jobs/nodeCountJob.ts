import cron from 'node-cron';
import { sampleRegisteredClusters } from '../node-count-sampler';

const NODE_COUNT_JOB_KEY = '__secureNexusNodeCountJobStarted__';

let hourlyJob: ReturnType<typeof cron.schedule> | null = null;

export function initNodeCountJob(): void {
  const g = globalThis as typeof globalThis & { [NODE_COUNT_JOB_KEY]?: boolean };
  if (g[NODE_COUNT_JOB_KEY]) return;
  g[NODE_COUNT_JOB_KEY] = true;

  console.log('[NodeCount] Initializing hourly node count sampler…');

  hourlyJob = cron.schedule('5 * * * *', () => {
    void sampleRegisteredClusters().catch((err) => {
      console.error('[NodeCount] Hourly sample failed:', err);
    });
  });

  setTimeout(() => {
    void sampleRegisteredClusters().catch((err) => {
      console.error('[NodeCount] Startup sample failed:', err);
    });
  }, 45_000);
}

export function stopNodeCountJob(): void {
  hourlyJob?.stop();
  hourlyJob = null;
}

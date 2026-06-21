import cron from 'node-cron';
import { invalidateNodeChangesCache } from '../node-changes-service';
import { invalidatePodChangesCache } from '../pod-changes-service';
import { sampleRegisteredClusters } from '../node-count-sampler';
import { sampleRegisteredClusterPods } from '../pod-count-sampler';

const NODE_COUNT_JOB_KEY = '__secureNexusNodeCountJobStarted__';

let hourlyJob: ReturnType<typeof cron.schedule> | null = null;

function invalidateHourlyCaches(): void {
  invalidateNodeChangesCache();
  invalidatePodChangesCache();
}

async function runHourlySamples(): Promise<void> {
  await Promise.all([sampleRegisteredClusters(), sampleRegisteredClusterPods()]);
  invalidateHourlyCaches();
}

export function initNodeCountJob(): void {
  const g = globalThis as typeof globalThis & { [NODE_COUNT_JOB_KEY]?: boolean };
  if (g[NODE_COUNT_JOB_KEY]) return;
  g[NODE_COUNT_JOB_KEY] = true;

  console.log('[NodeCount] Initializing 15-minute node & pod count sampler…');

  hourlyJob = cron.schedule('*/15 * * * *', () => {
    void runHourlySamples().catch((err) => {
      console.error('[NodeCount] Hourly sample failed:', err);
    });
  });

  setTimeout(() => {
    void runHourlySamples().catch((err) => {
      console.error('[NodeCount] Startup sample failed:', err);
    });
  }, 45_000);
}

export function stopNodeCountJob(): void {
  hourlyJob?.stop();
  hourlyJob = null;
}

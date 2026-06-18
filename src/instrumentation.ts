export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initScheduler } = await import('./lib/scheduler-runner');
    const { initResourceAuditJob } = await import('./lib/jobs/resourceAuditJob');
    const { initGitSyncJob } = await import('./lib/jobs/gitSyncJob');
    const { initNodeCountJob } = await import('./lib/jobs/nodeCountJob');
    initScheduler();
    initResourceAuditJob();
    initGitSyncJob();
    initNodeCountJob();
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log(
      `[SecureNexus] Node runtime started (pid=${process.pid}, port=${process.env.PORT ?? '3005'})`
    );
    const { initScheduler } = await import('./lib/scheduler-runner');
    const { initResourceAuditJob } = await import('./lib/jobs/resourceAuditJob');
    const { initGitSyncJob } = await import('./lib/jobs/gitSyncJob');
    const { initNodeCountJob } = await import('./lib/jobs/nodeCountJob');
    const { initSecurityAutomationRunner } = await import('./lib/security-automation-runner');
    initScheduler();
    initResourceAuditJob();
    initGitSyncJob();
    initNodeCountJob();
    initSecurityAutomationRunner();
    console.log('[SecureNexus] Background jobs registered — logs appear here and in `pm2 logs securenexus`');
  }
}

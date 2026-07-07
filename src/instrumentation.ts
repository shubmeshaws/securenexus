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
    const { cleanupStaleZapEnvironment } = await import('./lib/security/zap-process-cleanup');
    cleanupStaleZapEnvironment().catch((err) => {
      console.warn('[SecureNexus] ZAP startup cleanup skipped:', err);
    });
    console.log('[SecureNexus] Background jobs registered — logs appear here and in `pm2 logs securenexus`');
  }
}

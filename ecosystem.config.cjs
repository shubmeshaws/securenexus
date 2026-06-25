module.exports = {
  apps: [
    {
      name: 'securenexus',
      script: 'npm',
      args: 'start',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3005,
        HOSTNAME: '0.0.0.0',
        // Dedicated stop/start trace — console (pm2 logs) + logs/schedule-runs.log
        SCHEDULE_RUN_LOG: '1',
        SCHEDULE_RUN_LOG_FILE: './logs/schedule-runs.log',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};

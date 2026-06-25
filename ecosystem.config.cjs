const path = require('path');

module.exports = {
  apps: [
    {
      name: 'securenexus',
      // Run Next.js directly — `npm start` as the PM2 script hides most app stdout/stderr.
      script: path.join(__dirname, 'node_modules/next/dist/bin/next'),
      args: 'start -H 0.0.0.0 -p 3005',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: '3005',
        HOSTNAME: '0.0.0.0',
      },
    },
  ],
};

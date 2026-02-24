module.exports = {
  apps: [
    {
      name: 'clutch-viewership',
      script: 'dist/index.js',
      cwd: '/opt/clutch-viewership-tracker',
      node_args: '--import tsx',
      env_production: {
        NODE_ENV: 'production',
      },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      // Logging
      error_file: '/var/log/clutch/error.log',
      out_file: '/var/log/clutch/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
  ],
};

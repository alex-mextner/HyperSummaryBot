module.exports = {
  apps: [
    {
      name: "hyper-summary-bot",
      script: "bun",
      args: "src/index.ts",
      cwd: "/var/www/hyper-summary-bot",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
      env_file: "/var/www/hyper-summary-bot/.env",
      out_file: "/var/www/hyper-summary-bot/logs/out.log",
      error_file: "/var/www/hyper-summary-bot/logs/error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      max_memory_restart: "512M",
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: "10s",
      watch: false,
      kill_timeout: 5000,
    },
  ],
};

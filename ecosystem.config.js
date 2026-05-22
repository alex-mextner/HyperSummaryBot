module.exports = {
  apps: [
    {
      name: "hyper-summary-bot",
      script: "bun",
      args: "src/index.ts",
      cwd: "/opt/hyper-summary-bot",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
      env_file: "/opt/hyper-summary-bot/.env",
      log_file: "./logs/combined.log",
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      time: true,
      max_memory_restart: "512M",
      restart_delay: 3000,
      max_restarts: 5,
      min_uptime: "10s",
      watch: false,
      kill_timeout: 5000,
    },
  ],
};

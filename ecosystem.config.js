/**
 * PM2 Ecosystem Configuration
 * 
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup
 */

module.exports = {
  apps: [
    {
      name: 'coin-pusher-server',
      script: './server/dist/index.js',
      cwd: '/var/www/coin-pusher',
      instances: 1, // 单实例，未来可扩展
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // 自动重启配置
      autorestart: true,
      watch: false, // 生产环境关闭 watch
      max_memory_restart: '500M', // 内存超过 500MB 重启
      
      // 日志配置
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',
      time: true, // 日志带时间戳
      merge_logs: true,
      
      // 其他配置
      min_uptime: '10s', // 至少运行 10 秒才算成功启动
      max_restarts: 10, // 最多重启 10 次
      restart_delay: 4000, // 重启延迟 4 秒
    },
  ],
};


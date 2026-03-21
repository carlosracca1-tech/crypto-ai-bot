/**
 * PM2 Ecosystem Config — AI Crypto Bot
 *
 * Uso:
 *   pm2 start ecosystem.config.js     → inicia el bot
 *   pm2 stop crypto-ai-bot            → para el bot
 *   pm2 logs crypto-ai-bot            → ver logs en tiempo real
 *   pm2 restart crypto-ai-bot         → reiniciar
 *   pm2 save                          → guardar para que arranque solo
 *   pm2 startup                       → configurar arranque automático con el sistema
 */

module.exports = {
  apps: [
    {
      name: 'crypto-ai-bot',

      // Script principal: scheduler con los 3 horarios de Argentina
      script: './scheduler/cron-argentina.js',

      // Reiniciar automáticamente si crashea
      autorestart: true,
      max_restarts: 10,
      restart_delay: 10000, // 10 segundos entre reinicios

      // No reiniciar si fue apagado manualmente
      stop_exit_codes: [0],

      // Carpeta de trabajo
      cwd: __dirname,

      // Variables de entorno
      env: {
        NODE_ENV: 'production',
      },

      // Logging
      out_file:   './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs:  true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // Memoria límite: reiniciar si supera 500MB
      max_memory_restart: '500M',

      // Watch: desactivado (no queremos reiniciar al editar archivos)
      watch: false,
    },
  ],
};

/**
 * ═══════════════════════════════════════════════════════════
 * PM2 ECOSYSTEM CONFIGURATION
 * 
 * Production-grade process management for WhatsApp Clinic Bot
 * 
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 logs
 *   pm2 monit
 *   pm2 restart all
 * ═══════════════════════════════════════════════════════════
 */

module.exports = {
  apps: [
    // ═══════════════════════════════════════════════════════
    // MAIN APPLICATION
    // ═══════════════════════════════════════════════════════
    {
      name: 'clinic-bot',
      script: 'bot.js',
      
      // Clustering for high availability
      instances: 'max',              // Use all CPU cores
      exec_mode: 'cluster',          // Cluster mode for load balancing
      
      // Auto-restart configuration
      watch: false,                  // Don't watch files in production
      max_memory_restart: '500M',    // Restart if exceeds 500MB
      autorestart: true,             // Auto-restart on crash
      max_restarts: 10,              // Max restart attempts
      min_uptime: '10s',             // Min uptime before considered stable
      restart_delay: 4000,           // Wait 4s before restart
      
      // Environment variables
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_staging: {
        NODE_ENV: 'staging',
        PORT: 3000,
      },
      
      // Logging
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      log_file: 'logs/pm2-combined.log',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      
      // Advanced options
      kill_timeout: 5000,            // Time to wait before force kill
      listen_timeout: 3000,          // Time to wait for app to listen
      shutdown_with_message: false,  // Don't shutdown on uncaught exceptions
      
      // Process management
      instance_var: 'INSTANCE_ID',   // Environment variable for instance ID
      
      // Monitoring
      pmx: true,                     // Enable PM2+ monitoring
      
      // Node.js options
      node_args: '--max-old-space-size=512',  // Increase heap size
    },
    
    // ═══════════════════════════════════════════════════════
    // CRON: AUTO-APPROVAL JOB
    // ═══════════════════════════════════════════════════════
    {
      name: 'cron-auto-approval',
      script: 'jobs/autoApproveReject.js',
      
      instances: 1,                  // Single instance for cron
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '200M',
      
      // Run every 30 minutes
      cron_restart: '*/30 * * * *',
      
      env: {
        NODE_ENV: 'production',
      },
      
      error_file: 'logs/cron-auto-approval-error.log',
      out_file: 'logs/cron-auto-approval-out.log',
      time: true,
    },
    
    // ═══════════════════════════════════════════════════════
    // CRON: REMINDER JOB
    // ═══════════════════════════════════════════════════════
    {
      name: 'cron-reminders',
      script: 'jobs/sendReminders.js',
      
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '200M',
      
      // Run every 3 hours
      cron_restart: '0 */3 * * *',
      
      env: {
        NODE_ENV: 'production',
      },
      
      error_file: 'logs/cron-reminders-error.log',
      out_file: 'logs/cron-reminders-out.log',
      time: true,
    },
    
    // ═══════════════════════════════════════════════════════
    // CRON: SESSION CLEANUP
    // ═══════════════════════════════════════════════════════
    {
      name: 'cron-cleanup',
      script: 'jobs/cleanupSessions.js',
      
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '100M',
      
      // Run every 6 hours
      cron_restart: '0 */6 * * *',
      
      env: {
        NODE_ENV: 'production',
      },
      
      error_file: 'logs/cron-cleanup-error.log',
      out_file: 'logs/cron-cleanup-out.log',
      time: true,
    },
    
    // ═══════════════════════════════════════════════════════
    // HEALTH MONITOR (Optional)
    // ═══════════════════════════════════════════════════════
    {
      name: 'health-monitor',
      script: 'scripts/healthMonitor.js',
      
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '100M',
      
      env: {
        NODE_ENV: 'production',
        MONITOR_INTERVAL: 60000,     // Check every 60 seconds
      },
      
      error_file: 'logs/health-monitor-error.log',
      out_file: 'logs/health-monitor-out.log',
      time: true,
    },
  ],
  
  // ═══════════════════════════════════════════════════════
  // DEPLOYMENT CONFIGURATION
  // ═══════════════════════════════════════════════════════
  deploy: {
    production: {
      user: 'deploy',
      host: 'your-server.com',
      ref: 'origin/main',
      repo: 'git@github.com:SOUROYAL123/clinis_database_bot-.git',
      path: '/var/www/clinic-bot',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
      'pre-setup': 'echo "Setting up production environment"',
    },
    staging: {
      user: 'deploy',
      host: 'staging-server.com',
      ref: 'origin/staging',
      repo: 'git@github.com:SOUROYAL123/clinis_database_bot-.git',
      path: '/var/www/clinic-bot-staging',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env staging',
    },
  },
};

/**
 * ═══════════════════════════════════════════════════════════
 * PM2 COMMANDS REFERENCE
 * ═══════════════════════════════════════════════════════════
 * 
 * START:
 *   pm2 start ecosystem.config.js
 *   pm2 start ecosystem.config.js --env production
 *   pm2 start ecosystem.config.js --only clinic-bot
 * 
 * MONITOR:
 *   pm2 list                    # List all processes
 *   pm2 monit                   # Live monitoring dashboard
 *   pm2 logs                    # View all logs
 *   pm2 logs clinic-bot         # Specific app logs
 *   pm2 logs --lines 100        # Last 100 lines
 * 
 * MANAGE:
 *   pm2 restart all             # Restart all apps
 *   pm2 restart clinic-bot      # Restart specific app
 *   pm2 reload all              # Zero-downtime reload
 *   pm2 stop all                # Stop all
 *   pm2 delete all              # Remove all
 * 
 * CLUSTER CONTROL:
 *   pm2 scale clinic-bot 4      # Scale to 4 instances
 *   pm2 scale clinic-bot +2     # Add 2 instances
 *   pm2 scale clinic-bot -1     # Remove 1 instance
 * 
 * INFORMATION:
 *   pm2 show clinic-bot         # Detailed info
 *   pm2 describe clinic-bot     # Full description
 *   pm2 env 0                   # Environment variables
 * 
 * STARTUP:
 *   pm2 startup                 # Generate startup script
 *   pm2 save                    # Save current process list
 *   pm2 resurrect               # Restore saved processes
 * 
 * LOGS:
 *   pm2 flush                   # Clear all logs
 *   pm2 reloadLogs              # Reload logs
 * 
 * PERFORMANCE:
 *   pm2 reset clinic-bot        # Reset restart counter
 *   pm2 reload --update-env     # Reload with env updates
 * 
 * DEPLOYMENT:
 *   pm2 deploy production setup         # First time setup
 *   pm2 deploy production               # Deploy to production
 *   pm2 deploy production revert 1      # Rollback 1 commit
 *   pm2 deploy staging                  # Deploy to staging
 * 
 * MONITORING (PM2+):
 *   pm2 register                # Register for PM2+ monitoring
 *   pm2 web                     # Web interface on port 9615
 * 
 * ═══════════════════════════════════════════════════════════
 * PRODUCTION CHECKLIST
 * ═══════════════════════════════════════════════════════════
 * 
 * 1. Install PM2 globally:
 *    npm install -g pm2
 * 
 * 2. Start application:
 *    pm2 start ecosystem.config.js --env production
 * 
 * 3. Save process list:
 *    pm2 save
 * 
 * 4. Setup auto-start on boot:
 *    pm2 startup
 *    # Run the command it outputs
 * 
 * 5. Monitor:
 *    pm2 monit
 * 
 * 6. Check logs:
 *    pm2 logs
 * 
 * 7. For updates:
 *    git pull
 *    npm install
 *    pm2 reload ecosystem.config.js --env production
 * 
 * ═══════════════════════════════════════════════════════════
 * TROUBLESHOOTING
 * ═══════════════════════════════════════════════════════════
 * 
 * App keeps restarting:
 *   pm2 logs clinic-bot --lines 50
 *   Check error_file for stack traces
 *   Verify max_memory_restart not too low
 * 
 * Out of memory:
 *   Increase max_memory_restart
 *   Check for memory leaks
 *   pm2 reload instead of restart
 * 
 * Logs not appearing:
 *   pm2 flush
 *   pm2 reloadLogs
 *   Check logs/ directory permissions
 * 
 * Can't connect to app:
 *   pm2 list # Check if running
 *   Check firewall/ports
 *   Verify environment variables
 * 
 * ═══════════════════════════════════════════════════════════
 */

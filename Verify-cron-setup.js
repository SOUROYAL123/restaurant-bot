/**
 * ═══════════════════════════════════════════════════════════
 * CRON JOB VERIFICATION SCRIPT
 * 
 * Checks if external cron jobs are hitting your endpoints
 * Usage: Run this and wait 30 minutes to see if crons work
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const express = require('express');
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const app = express();
const PORT = process.env.PORT || 8080;

// Store cron hits in memory
const cronHits = {
    reminders: [],
    autoApproval: []
};

// Track cron endpoint hits
app.post('/cron/send-reminders', async (req, res) => {
    const timestamp = new Date().toISOString();
    cronHits.reminders.push(timestamp);
    
    console.log(`✅ REMINDER CRON HIT at ${timestamp}`);
    
    res.json({
        success: true,
        message: 'Reminder cron received',
        timestamp: timestamp,
        totalHits: cronHits.reminders.length
    });
});

app.post('/cron/auto-approval', async (req, res) => {
    const timestamp = new Date().toISOString();
    cronHits.autoApproval.push(timestamp);
    
    console.log(`✅ AUTO-APPROVAL CRON HIT at ${timestamp}`);
    
    res.json({
        success: true,
        message: 'Auto-approval cron received',
        timestamp: timestamp,
        totalHits: cronHits.autoApproval.length
    });
});

// Status endpoint to check cron activity
app.get('/cron/status', (req, res) => {
    const now = new Date();
    
    const lastReminderHit = cronHits.reminders.length > 0 
        ? cronHits.reminders[cronHits.reminders.length - 1]
        : 'Never';
    
    const lastAutoApprovalHit = cronHits.autoApproval.length > 0
        ? cronHits.autoApproval[cronHits.autoApproval.length - 1]
        : 'Never';
    
    const minutesSinceLastReminder = cronHits.reminders.length > 0
        ? Math.floor((now - new Date(lastReminderHit)) / (1000 * 60))
        : null;
    
    const minutesSinceLastAutoApproval = cronHits.autoApproval.length > 0
        ? Math.floor((now - new Date(lastAutoApprovalHit)) / (1000 * 60))
        : null;
    
    const status = {
        currentTime: now.toISOString(),
        reminders: {
            configured: cronHits.reminders.length > 0,
            totalHits: cronHits.reminders.length,
            lastHit: lastReminderHit,
            minutesSinceLastHit: minutesSinceLastReminder,
            expectedInterval: '30 minutes',
            status: minutesSinceLastReminder === null 
                ? '❌ Not configured'
                : minutesSinceLastReminder <= 35
                ? '✅ Working'
                : '⚠️ Delayed',
            allHits: cronHits.reminders
        },
        autoApproval: {
            configured: cronHits.autoApproval.length > 0,
            totalHits: cronHits.autoApproval.length,
            lastHit: lastAutoApprovalHit,
            minutesSinceLastHit: minutesSinceLastAutoApproval,
            expectedInterval: '10 minutes',
            status: minutesSinceLastAutoApproval === null
                ? '❌ Not configured'
                : minutesSinceLastAutoApproval <= 15
                ? '✅ Working'
                : '⚠️ Delayed',
            allHits: cronHits.autoApproval
        }
    };
    
    res.json(status);
});

app.get('/', (req, res) => {
    const instructions = `
╔═══════════════════════════════════════════════════════════╗
║          CRON JOB VERIFICATION SERVER                     ║
╚═══════════════════════════════════════════════════════════╝

This server is running to verify if your cron jobs are working.

📊 CHECK STATUS:
   GET ${process.env.BASE_URL}/cron/status

🔧 SETUP INSTRUCTIONS:

1. Go to cron-job.org and create 2 jobs:

   JOB 1: Send Reminders
   URL: POST ${process.env.BASE_URL}/cron/send-reminders
   Schedule: */30 * * * * (Every 30 minutes)
   
   JOB 2: Auto-Approval
   URL: POST ${process.env.BASE_URL}/cron/auto-approval
   Schedule: */10 * * * * (Every 10 minutes)

2. Wait 30-60 minutes

3. Check status endpoint to verify hits

4. Once working, you can stop this test server

═══════════════════════════════════════════════════════════
Server running at ${process.env.BASE_URL}
`;
    
    res.type('text/plain').send(instructions);
});

app.listen(PORT, () => {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║          CRON VERIFICATION SERVER STARTED                 ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log(`🌐 Server: ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
    console.log(`📊 Status: ${process.env.BASE_URL || `http://localhost:${PORT}`}/cron/status\n`);
    console.log('⏳ Waiting for cron jobs to hit endpoints...\n');
    console.log('SETUP YOUR CRON JOBS NOW:');
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log('1. Go to: https://cron-job.org\n');
    console.log('2. Add Job #1:');
    console.log(`   URL: POST ${process.env.BASE_URL}/cron/send-reminders`);
    console.log('   Schedule: */30 * * * * (Every 30 minutes)\n');
    console.log('3. Add Job #2:');
    console.log(`   URL: POST ${process.env.BASE_URL}/cron/auto-approval`);
    console.log('   Schedule: */10 * * * * (Every 10 minutes)\n');
    console.log('4. Enable both jobs and save\n');
    console.log('5. Wait 30 minutes and watch this console\n');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    // Show status every 5 minutes
    setInterval(() => {
        const now = new Date();
        console.log(`\n📊 Status Check at ${now.toLocaleTimeString()}`);
        console.log('───────────────────────────────────────────────────────────');
        console.log(`Reminder Cron Hits: ${cronHits.reminders.length}`);
        if (cronHits.reminders.length > 0) {
            const last = cronHits.reminders[cronHits.reminders.length - 1];
            const minutesAgo = Math.floor((now - new Date(last)) / (1000 * 60));
            console.log(`   Last hit: ${minutesAgo} minutes ago`);
            console.log(`   Status: ${minutesAgo <= 35 ? '✅ Working' : '⚠️ Delayed'}`);
        } else {
            console.log('   Status: ❌ Not configured yet');
        }
        
        console.log(`\nAuto-Approval Cron Hits: ${cronHits.autoApproval.length}`);
        if (cronHits.autoApproval.length > 0) {
            const last = cronHits.autoApproval[cronHits.autoApproval.length - 1];
            const minutesAgo = Math.floor((now - new Date(last)) / (1000 * 60));
            console.log(`   Last hit: ${minutesAgo} minutes ago`);
            console.log(`   Status: ${minutesAgo <= 15 ? '✅ Working' : '⚠️ Delayed'}`);
        } else {
            console.log('   Status: ❌ Not configured yet');
        }
        console.log('───────────────────────────────────────────────────────────\n');
    }, 5 * 60 * 1000); // Every 5 minutes
});

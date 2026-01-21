/**
 * ═══════════════════════════════════════════════════════════
 * REMINDER SYSTEM DIAGNOSTIC TOOL
 * 
 * Checks all components of the reminder system
 * Usage: node diagnose-reminders.js
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function diagnose() {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║     REMINDER SYSTEM DIAGNOSTIC REPORT                 ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
    
    const results = {
        database: { status: '❌', details: [] },
        appointments: { status: '❌', details: [] },
        configuration: { status: '❌', details: [] },
        cronSetup: { status: '❌', details: [] }
    };
    
    try {
        // ═══════════════════════════════════════════════════════════
        // 1. CHECK DATABASE SCHEMA
        // ═══════════════════════════════════════════════════════════
        console.log('📊 1. CHECKING DATABASE SCHEMA\n');
        console.log('   Verifying reminder columns exist...\n');
        
        const columns = await sql`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'appointments' 
            AND column_name IN (
                'reminder_sent',
                'reminder_sent_at', 
                'reminder_24h_sent',
                'reminder_2h_sent'
            )
            ORDER BY column_name
        `;
        
        const requiredColumns = ['reminder_24h_sent', 'reminder_2h_sent'];
        const foundColumns = columns.map(c => c.column_name);
        
        console.log('   Found columns:');
        columns.forEach(col => {
            console.log(`   ✓ ${col.column_name} (${col.data_type})`);
        });
        
        const missingColumns = requiredColumns.filter(col => !foundColumns.includes(col));
        
        if (missingColumns.length > 0) {
            console.log('\n   ❌ MISSING COLUMNS:');
            missingColumns.forEach(col => {
                console.log(`   ✗ ${col}`);
            });
            results.database.status = '❌';
            results.database.details.push(`Missing columns: ${missingColumns.join(', ')}`);
        } else {
            console.log('\n   ✅ All required columns exist');
            results.database.status = '✅';
        }
        
        // ═══════════════════════════════════════════════════════════
        // 2. CHECK ELIGIBLE APPOINTMENTS
        // ═══════════════════════════════════════════════════════════
        console.log('\n\n📅 2. CHECKING ELIGIBLE APPOINTMENTS\n');
        
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowDate = tomorrow.toISOString().split('T')[0];
        const todayDate = now.toISOString().split('T')[0];
        
        // 24-hour reminders (for tomorrow)
        const eligible24h = await sql`
            SELECT 
                id,
                patient_name,
                patient_phone,
                appointment_date,
                appointment_time,
                status,
                reminder_24h_sent,
                created_at
            FROM appointments
            WHERE appointment_date = ${tomorrowDate}
            AND status = 'confirmed'
            ORDER BY appointment_time
        `;
        
        console.log(`   📋 24-Hour Reminders (Tomorrow: ${tomorrowDate})`);
        console.log(`   Total confirmed appointments: ${eligible24h.length}`);
        
        const unsent24h = eligible24h.filter(a => !a.reminder_24h_sent);
        console.log(`   Not yet sent: ${unsent24h.length}`);
        console.log(`   Already sent: ${eligible24h.length - unsent24h.length}\n`);
        
        if (unsent24h.length > 0) {
            console.log('   Pending 24h reminders:');
            unsent24h.slice(0, 5).forEach(a => {
                console.log(`   • #${a.id} - ${a.patient_name} @ ${a.appointment_time}`);
                console.log(`     Phone: ${a.patient_phone}`);
            });
            if (unsent24h.length > 5) {
                console.log(`   ... and ${unsent24h.length - 5} more`);
            }
        }
        
        // 2-hour reminders (for today)
        const eligible2h = await sql`
            SELECT 
                id,
                patient_name,
                patient_phone,
                appointment_date,
                appointment_time,
                status,
                reminder_2h_sent,
                created_at
            FROM appointments
            WHERE appointment_date = ${todayDate}
            AND status = 'confirmed'
            ORDER BY appointment_time
        `;
        
        console.log(`\n   ⏰ 2-Hour Reminders (Today: ${todayDate})`);
        console.log(`   Total confirmed appointments: ${eligible2h.length}`);
        
        const unsent2h = eligible2h.filter(a => !a.reminder_2h_sent);
        console.log(`   Not yet sent: ${unsent2h.length}`);
        console.log(`   Already sent: ${eligible2h.length - unsent2h.length}\n`);
        
        if (unsent2h.length > 0) {
            const currentHour = now.getHours();
            const currentMinute = now.getMinutes();
            const currentTotalMinutes = currentHour * 60 + currentMinute;
            
            console.log('   Pending 2h reminders:');
            unsent2h.forEach(a => {
                // Parse appointment time
                const timeMatch = a.appointment_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
                if (timeMatch) {
                    let hour = parseInt(timeMatch[1]);
                    const minute = parseInt(timeMatch[2]);
                    const period = timeMatch[3].toUpperCase();
                    
                    if (period === 'PM' && hour !== 12) hour += 12;
                    if (period === 'AM' && hour === 12) hour = 0;
                    
                    const appointmentTotalMinutes = hour * 60 + minute;
                    const minutesDiff = appointmentTotalMinutes - currentTotalMinutes;
                    const hoursDiff = (minutesDiff / 60).toFixed(1);
                    
                    const inWindow = minutesDiff >= 140 && minutesDiff <= 160;
                    const status = inWindow ? '🎯 IN WINDOW' : minutesDiff > 160 ? '⏭️ Too early' : '⏰ Too late';
                    
                    console.log(`   • #${a.id} - ${a.patient_name} @ ${a.appointment_time}`);
                    console.log(`     ${status} (${hoursDiff}h away, ${minutesDiff} min)`);
                }
            });
        }
        
        if (unsent24h.length > 0 || unsent2h.length > 0) {
            results.appointments.status = '⚠️';
            results.appointments.details.push(`${unsent24h.length} pending 24h reminders`);
            results.appointments.details.push(`${unsent2h.length} pending 2h reminders`);
        } else {
            results.appointments.status = '✅';
            results.appointments.details.push('No pending reminders');
        }
        
        // ═══════════════════════════════════════════════════════════
        // 3. CHECK CONFIGURATION
        // ═══════════════════════════════════════════════════════════
        console.log('\n\n⚙️  3. CHECKING CONFIGURATION\n');
        
        const config = {
            TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
            TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
            WABA_NUMBER: process.env.WABA_NUMBER,
            BASE_URL: process.env.BASE_URL,
            DATABASE_URL: process.env.DATABASE_URL,
            REMINDER_24H_ENABLED: process.env.REMINDER_24H_ENABLED,
            REMINDER_2H_ENABLED: process.env.REMINDER_2H_ENABLED
        };
        
        let configOk = true;
        
        Object.entries(config).forEach(([key, value]) => {
            const exists = !!value;
            const display = key.includes('TOKEN') || key.includes('SID') || key.includes('DATABASE') 
                ? (value ? `${value.substring(0, 10)}***` : 'NOT SET')
                : (value || 'NOT SET');
            
            console.log(`   ${exists ? '✓' : '✗'} ${key.padEnd(25)} = ${display}`);
            
            if (!exists && !key.includes('ENABLED')) {
                configOk = false;
            }
        });
        
        if (configOk) {
            results.configuration.status = '✅';
        } else {
            results.configuration.status = '❌';
            results.configuration.details.push('Missing environment variables');
        }
        
        // ═══════════════════════════════════════════════════════════
        // 4. CHECK CRON SETUP
        // ═══════════════════════════════════════════════════════════
        console.log('\n\n🤖 4. CRON JOB SETUP STATUS\n');
        
        console.log('   ⚠️  CRITICAL: Reminders require external cron jobs!\n');
        console.log('   These must be configured at cron-job.org:\n');
        
        console.log('   📍 Auto-Approval Cron:');
        console.log(`      URL: POST ${process.env.BASE_URL}/cron/auto-approval`);
        console.log('      Schedule: */10 * * * * (Every 10 minutes)');
        console.log('      Status: ⚠️  MANUAL SETUP REQUIRED\n');
        
        console.log('   📍 Reminder Cron:');
        console.log(`      URL: POST ${process.env.BASE_URL}/cron/send-reminders`);
        console.log('      Schedule: */30 * * * * (Every 30 minutes) ⭐ CRITICAL');
        console.log('      Status: ⚠️  MANUAL SETUP REQUIRED\n');
        
        results.cronSetup.status = '⚠️';
        results.cronSetup.details.push('Manual configuration required');
        
        // ═══════════════════════════════════════════════════════════
        // 5. TEST REMINDER ENDPOINT
        // ═══════════════════════════════════════════════════════════
        console.log('\n📡 5. TESTING REMINDER ENDPOINT\n');
        
        console.log(`   Test endpoint: ${process.env.BASE_URL}/cron/send-reminders/test`);
        console.log('   Use: GET request to check endpoint availability\n');
        
        // ═══════════════════════════════════════════════════════════
        // SUMMARY
        // ═══════════════════════════════════════════════════════════
        console.log('\n╔════════════════════════════════════════════════════════╗');
        console.log('║                  DIAGNOSTIC SUMMARY                    ║');
        console.log('╚════════════════════════════════════════════════════════╝\n');
        
        console.log(`   Database Schema:    ${results.database.status}`);
        if (results.database.details.length > 0) {
            results.database.details.forEach(d => console.log(`      - ${d}`));
        }
        
        console.log(`\n   Appointments:       ${results.appointments.status}`);
        if (results.appointments.details.length > 0) {
            results.appointments.details.forEach(d => console.log(`      - ${d}`));
        }
        
        console.log(`\n   Configuration:      ${results.configuration.status}`);
        if (results.configuration.details.length > 0) {
            results.configuration.details.forEach(d => console.log(`      - ${d}`));
        }
        
        console.log(`\n   Cron Setup:         ${results.cronSetup.status}`);
        results.cronSetup.details.forEach(d => console.log(`      - ${d}`));
        
        // ═══════════════════════════════════════════════════════════
        // NEXT STEPS
        // ═══════════════════════════════════════════════════════════
        console.log('\n\n╔════════════════════════════════════════════════════════╗');
        console.log('║                    NEXT STEPS                          ║');
        console.log('╚════════════════════════════════════════════════════════╝\n');
        
        if (results.database.status === '❌') {
            console.log('   1️⃣ FIX DATABASE SCHEMA:');
            console.log('      Run the migration to add missing columns\n');
        }
        
        if (results.appointments.status === '⚠️') {
            console.log('   2️⃣ SETUP CRON JOBS (CRITICAL!):');
            console.log('      a) Go to https://cron-job.org');
            console.log('      b) Create account and add 2 jobs:\n');
            console.log('         Job 1: Auto-Approval');
            console.log(`         URL: POST ${process.env.BASE_URL}/cron/auto-approval`);
            console.log('         Schedule: Every 10 minutes\n');
            console.log('         Job 2: Send Reminders ⭐');
            console.log(`         URL: POST ${process.env.BASE_URL}/cron/send-reminders`);
            console.log('         Schedule: Every 30 minutes (CRITICAL!)\n');
        }
        
        console.log('   3️⃣ TEST MANUALLY:');
        console.log('      Run: node test-manual-reminder.js\n');
        
        console.log('═══════════════════════════════════════════════════════════\n');
        
    } catch (error) {
        console.error('\n❌ Diagnostic failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

diagnose().then(() => {
    console.log('✅ Diagnostic complete!\n');
    process.exit(0);
});

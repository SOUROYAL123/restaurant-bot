/**
 * ═══════════════════════════════════════════════════════════
 * Test Reminder System
 * 
 * Creates test appointments and sends test reminders
 * Usage: node test-reminder-system.js
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const { sendReminders } = require('./sendReminders');

const sql = neon(process.env.DATABASE_URL);

async function testReminderSystem() {
    console.log('🧪 Testing Reminder System\n');
    console.log('═══════════════════════════════════════════════\n');
    
    try {
        // Step 1: Check if reminder columns exist
        console.log('1️⃣ Checking database schema...');
        const columns = await sql`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'appointments' 
            AND column_name IN ('reminder_sent', 'reminder_sent_at')
        `;
        
        if (columns.length < 2) {
            console.log('❌ Reminder columns not found!');
            console.log('Run: npm run db:migrate migrations/add-reminder-system.sql\n');
            process.exit(1);
        }
        console.log('✅ Schema ready\n');
        
        // Step 2: Create test appointment for tomorrow
        console.log('2️⃣ Creating test appointment...');
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowDate = tomorrow.toISOString().split('T')[0];
        
        const testAppointment = await sql`
            INSERT INTO appointments (
                clinic_id,
                patient_name,
                patient_phone,
                appointment_date,
                appointment_time,
                appointment_slot,
                status,
                reminder_sent
            ) VALUES (
                1,
                'Test Patient - Reminder',
                '+918013610018',
                ${tomorrowDate},
                '10:00 AM',
                '10:00 AM',
                'confirmed',
                false
            )
            RETURNING id, patient_name, appointment_date, appointment_time
        `;
        
        console.log(`✅ Created appointment #${testAppointment[0].id}`);
        console.log(`   Patient: ${testAppointment[0].patient_name}`);
        console.log(`   Date: ${testAppointment[0].appointment_date}`);
        console.log(`   Time: ${testAppointment[0].appointment_time}\n`);
        
        // Step 3: Check appointments eligible for reminders
        console.log('3️⃣ Checking eligible appointments...');
        const eligible = await sql`
            SELECT 
                id,
                patient_name,
                appointment_date,
                appointment_time,
                reminder_sent,
                EXTRACT(EPOCH FROM (appointment_date - NOW())) / 3600 as hours_until
            FROM appointments
            WHERE 
                status = 'confirmed'
                AND reminder_sent = false
                AND appointment_date > NOW()
            ORDER BY appointment_date ASC
            LIMIT 10
        `;
        
        console.log(`Found ${eligible.length} eligible appointment(s):\n`);
        eligible.forEach(appt => {
            console.log(`   #${appt.id}: ${appt.patient_name}`);
            console.log(`   📅 ${appt.appointment_date} @ ${appt.appointment_time}`);
            console.log(`   ⏰ ${Math.round(appt.hours_until)} hours until appointment`);
            console.log('');
        });
        
        // Step 4: Ask to send test reminder
        console.log('4️⃣ Testing reminder function...');
        console.log('⚠️  This will send WhatsApp messages!\n');
        
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        rl.question('Send test reminder now? (yes/no): ', async (answer) => {
            if (answer.toLowerCase() === 'yes') {
                console.log('\n📤 Sending reminders...\n');
                
                const result = await sendReminders();
                
                console.log('\n✅ Test completed!');
                console.log(`📊 Result: ${result.sent}/${result.total || 0} reminders sent\n`);
                
                // Show updated status
                const updated = await sql`
                    SELECT id, patient_name, reminder_sent, reminder_sent_at
                    FROM appointments
                    WHERE id = ${testAppointment[0].id}
                `;
                
                console.log('📋 Test Appointment Status:');
                console.log(`   ID: #${updated[0].id}`);
                console.log(`   Reminder Sent: ${updated[0].reminder_sent ? '✅ Yes' : '❌ No'}`);
                console.log(`   Sent At: ${updated[0].reminder_sent_at || 'N/A'}\n`);
                
            } else {
                console.log('\n⏭️  Skipped sending reminders\n');
            }
            
            // Cleanup
            console.log('5️⃣ Cleanup...');
            rl.question('Delete test appointment? (yes/no): ', async (cleanup) => {
                if (cleanup.toLowerCase() === 'yes') {
                    await sql`
                        DELETE FROM appointments 
                        WHERE id = ${testAppointment[0].id}
                    `;
                    console.log(`✅ Deleted test appointment #${testAppointment[0].id}\n`);
                }
                
                console.log('═══════════════════════════════════════════════');
                console.log('🎉 Reminder System Test Complete!\n');
                console.log('Next Steps:');
                console.log('1. Setup cron job at cron-job.org');
                console.log('2. URL: https://clinis-database-bot.onrender.com/cron/send-reminders');
                console.log('3. Schedule: Every 3 hours (0 */3 * * *)');
                console.log('═══════════════════════════════════════════════\n');
                
                rl.close();
                process.exit(0);
            });
        });
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

testReminderSystem();

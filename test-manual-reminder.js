/**
 * ═══════════════════════════════════════════════════════════
 * MANUAL REMINDER TEST
 * 
 * Tests reminder sending without waiting for cron
 * Usage: node test-manual-reminder.js
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const twilio = require('twilio');

const sql = neon(process.env.DATABASE_URL);
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

function formatDoctorName(name) {
    if (!name) return '';
    const cleaned = name.trim().replace(/^(Dr\.?\s*|DR\.?\s*|dr\.?\s*)/i, '');
    return `Dr. ${cleaned}`;
}

async function sendWhatsApp(to, message) {
    try {
        const phone = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
        
        const msg = await twilioClient.messages.create({
            from: process.env.WABA_NUMBER,
            to: phone,
            body: message
        });
        
        console.log(`   ✅ Message sent! SID: ${msg.sid}`);
        return true;
    } catch (error) {
        console.error(`   ❌ Failed to send: ${error.message}`);
        return false;
    }
}

async function testManualReminder() {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║          MANUAL REMINDER TEST                          ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
    
    try {
        // Get tomorrow's date for 24h reminder test
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowDate = tomorrow.toISOString().split('T')[0];
        
        console.log('📋 Finding appointments eligible for 24-hour reminders...\n');
        
        const appointments = await sql`
            SELECT 
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_date,
                a.appointment_time,
                a.status,
                a.reminder_24h_sent,
                c.name as clinic_name,
                c.doctor_name,
                d.name as assigned_doctor_name,
                d.specialization as assigned_doctor_specialization
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            LEFT JOIN doctors d ON a.doctor_id = d.id
            WHERE a.appointment_date = ${tomorrowDate}
            AND a.status = 'confirmed'
            AND a.reminder_24h_sent = false
            ORDER BY a.appointment_time
            LIMIT 5
        `;
        
        if (appointments.length === 0) {
            console.log('⚠️  No eligible appointments found for tomorrow');
            console.log('   Create a test appointment for tomorrow to test reminders\n');
            
            // Offer to create test appointment
            const readline = require('readline');
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            
            rl.question('Create test appointment for tomorrow? (yes/no): ', async (answer) => {
                if (answer.toLowerCase() === 'yes') {
                    const testAppt = await sql`
                        INSERT INTO appointments (
                            clinic_id,
                            patient_name,
                            patient_phone,
                            appointment_date,
                            appointment_time,
                            appointment_slot,
                            status,
                            reminder_24h_sent,
                            reminder_2h_sent
                        ) VALUES (
                            1,
                            'Test Patient - Manual Reminder',
                            '+918013610018',
                            ${tomorrowDate},
                            '10:00 AM',
                            '10:00 AM',
                            'confirmed',
                            false,
                            false
                        )
                        RETURNING id
                    `;
                    
                    console.log(`\n   ✅ Created test appointment #${testAppt[0].id}`);
                    console.log('   Re-run this script to send test reminder\n');
                }
                
                rl.close();
                process.exit(0);
            });
            
            return;
        }
        
        console.log(`✅ Found ${appointments.length} eligible appointment(s)\n`);
        
        // Show appointments
        appointments.forEach((apt, index) => {
            console.log(`${index + 1}. #${apt.id} - ${apt.patient_name}`);
            console.log(`   Date: Tomorrow (${apt.appointment_date})`);
            console.log(`   Time: ${apt.appointment_time}`);
            console.log(`   Clinic: ${apt.clinic_name}`);
            console.log(`   Phone: ${apt.patient_phone}\n`);
        });
        
        // Ask user to confirm
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        rl.question('Send reminder to these appointments? (yes/no): ', async (answer) => {
            if (answer.toLowerCase() !== 'yes') {
                console.log('\n⏭️  Test cancelled\n');
                rl.close();
                process.exit(0);
                return;
            }
            
            console.log('\n📤 Sending reminders...\n');
            
            let sent = 0;
            let failed = 0;
            
            for (const apt of appointments) {
                console.log(`Processing #${apt.id} - ${apt.patient_name}...`);
                
                const dateStr = new Date(apt.appointment_date).toLocaleDateString('en-IN', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric'
                });
                
                const doctorName = apt.assigned_doctor_name || apt.doctor_name;
                const doctorSpec = apt.assigned_doctor_specialization || 'General';
                
                let message = `🔔 *REMINDER - TOMORROW*\n\n━━━━━━━━━━━━━━━━━━━━\n📋 #${apt.id}\n🏥 ${apt.clinic_name}\n`;
                
                if (doctorName) {
                    message += `👨‍⚕️ ${formatDoctorName(doctorName)}\n`;
                    message += `🩺 ${doctorSpec}\n`;
                }
                
                message += `\n📅 *TOMORROW*\n⏰ ${apt.appointment_time}\n━━━━━━━━━━━━━━━━━━━━\n\n✔ Please arrive 10 min early\n✔ Bring any documents\n\nSee you tomorrow!\n\n━━━━━━━━━━━━━━━━━━━━\n✅ CONFIRM #${apt.id}\n❌ CANCEL #${apt.id}`;
                
                const success = await sendWhatsApp(apt.patient_phone, message);
                
                if (success) {
                    // Mark as sent
                    await sql`
                        UPDATE appointments 
                        SET reminder_24h_sent = true,
                            updated_at = NOW()
                        WHERE id = ${apt.id}
                    `;
                    sent++;
                    console.log(`   ✅ Reminder sent and marked in database\n`);
                } else {
                    failed++;
                    console.log(`   ❌ Failed to send reminder\n`);
                }
                
                // Wait 1 second between messages
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            console.log('\n╔════════════════════════════════════════════════════════╗');
            console.log('║                  TEST RESULTS                          ║');
            console.log('╚════════════════════════════════════════════════════════╝\n');
            console.log(`   ✅ Sent: ${sent}`);
            console.log(`   ❌ Failed: ${failed}`);
            console.log(`   📊 Total: ${sent + failed}\n`);
            
            if (sent > 0) {
                console.log('✅ Reminder system is working!\n');
                console.log('Next steps:');
                console.log('1. Setup cron job at cron-job.org');
                console.log(`2. URL: POST ${process.env.BASE_URL}/cron/send-reminders`);
                console.log('3. Schedule: Every 30 minutes\n');
            } else {
                console.log('⚠️  No reminders sent. Check:');
                console.log('1. Twilio credentials in .env');
                console.log('2. WABA number is correct');
                console.log('3. Phone numbers are in correct format\n');
            }
            
            rl.close();
            process.exit(0);
        });
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

testManualReminder();

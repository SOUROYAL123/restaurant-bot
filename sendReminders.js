
/**
 * ═══════════════════════════════════════════════════════════
 * ENHANCED REMINDER SYSTEM v2.0
 * - 24-hour reminder
 * - 2-hour reminder  
 * - Interactive confirmation buttons
 * - Waitlist auto-notification
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const { sendWhatsAppMessage } = require('./utils/twilioClient');

const sql = neon(process.env.DATABASE_URL);

/**
 * Send 24-hour reminder
 */
async function send24HourReminders() {
    try {
        console.log('📨 Sending 24-hour reminders...');
        
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowDate = tomorrow.toISOString().split('T')[0];
        
        const appointments = await sql`
            SELECT 
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_date,
                a.appointment_time,
                a.appointment_slot,
                a.payment_status,
                c.name as clinic_name,
                c.doctor_name
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE 
                a.appointment_date = ${tomorrowDate}
                AND a.status IN ('pending', 'confirmed')
                AND a.reminder_24h_sent = false
            ORDER BY a.appointment_time
        `;
        
        let sent = 0;
        
        for (const appt of appointments) {
            const message = generate24HourReminderMessage(appt);
            
            await sendWhatsAppMessage(appt.patient_phone, message);
            
            // Mark as sent
            await sql`
                UPDATE appointments 
                SET reminder_24h_sent = true, updated_at = NOW()
                WHERE id = ${appt.id}
            `;
            
            sent++;
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        console.log(`✅ Sent ${sent} 24-hour reminders`);
        return { sent };
        
    } catch (error) {
        console.error('❌ 24-hour reminder failed:', error.message);
        throw error;
    }
}

/**
 * Send 2-hour reminder
 */
async function send2HourReminders() {
    try {
        console.log('📨 Sending 2-hour reminders...');
        
        const now = new Date();
        const twoHoursLater = new Date(now.getTime() + (2 * 60 * 60 * 1000));
        
        const appointments = await sql`
            SELECT 
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_date,
                a.appointment_time,
                a.appointment_slot,
                c.name as clinic_name,
                c.doctor_name
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE 
                a.appointment_date = CURRENT_DATE
                AND a.status = 'confirmed'
                AND a.reminder_2h_sent = false
                AND a.appointment_time IS NOT NULL
        `;
        
        let sent = 0;
        
        for (const appt of appointments) {
            // Parse appointment time
            const apptTime = parseAppointmentTime(appt.appointment_time);
            const apptDateTime = new Date(appt.appointment_date);
            apptDateTime.setHours(apptTime.hours, apptTime.minutes);
            
            // Check if appointment is 1.5-2.5 hours away
            const hoursUntil = (apptDateTime - now) / (1000 * 60 * 60);
            
            if (hoursUntil >= 1.5 && hoursUntil <= 2.5) {
                const message = generate2HourReminderMessage(appt);
                
                await sendWhatsAppMessage(appt.patient_phone, message);
                
                // Mark as sent
                await sql`
                    UPDATE appointments 
                    SET reminder_2h_sent = true, updated_at = NOW()
                    WHERE id = ${appt.id}
                `;
                
                sent++;
                
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        console.log(`✅ Sent ${sent} 2-hour reminders`);
        return { sent };
        
    } catch (error) {
        console.error('❌ 2-hour reminder failed:', error.message);
        throw error;
    }
}

/**
 * Generate 24-hour reminder message with interactive options
 */
function generate24HourReminderMessage(appt) {
    const dateStr = new Date(appt.appointment_date).toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
    });
    
    const paymentWarning = appt.payment_status === 'pending' 
        ? `\n⚠️ *Deposit payment pending*\nComplete payment to confirm slot\n` 
        : '';
    
    return `🔔 *Appointment Reminder - Tomorrow*\n\n` +
        `📅 ${dateStr}\n` +
        `⏰ ${appt.appointment_time}\n` +
        `🏥 ${appt.clinic_name}\n` +
        `👨‍⚕️ Dr. ${appt.doctor_name}\n\n` +
        `📋 Booking #${appt.id}\n` +
        paymentWarning +
        `\n━━━━━━━━━━━━━━━━━━━━━\n` +
        `*Quick Actions:*\n\n` +
        `✅ Reply: CONFIRM ${appt.id}\n` +
        `🔄 Reply: RESCHEDULE ${appt.id}\n` +
        `❌ Reply: CANCEL ${appt.id}\n\n` +
        `Please arrive 10 minutes early.`;
}

/**
 * Generate 2-hour reminder message
 */
function generate2HourReminderMessage(appt) {
    return `⏰ *Final Reminder - 2 Hours*\n\n` +
        `Your appointment is in 2 hours:\n\n` +
        `🕒 ${appt.appointment_time}\n` +
        `🏥 ${appt.clinic_name}\n` +
        `👨‍⚕️ Dr. ${appt.doctor_name}\n\n` +
        `📍 Please start heading to the clinic\n` +
        `🚗 Arrive 10 minutes early\n\n` +
        `See you soon! 😊`;
}

/**
 * Parse appointment time string to hours/minutes
 */
function parseAppointmentTime(timeStr) {
    // Handle formats like "10:00 AM", "2:30 PM"
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return { hours: 9, minutes: 0 };
    
    let hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const period = match[3].toUpperCase();
    
    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;
    
    return { hours, minutes };
}

/**
 * Main reminder function - run via cron
 */
async function sendReminders() {
    try {
        console.log('🤖 Starting reminder job...\n');
        
        const result24h = await send24HourReminders();
        const result2h = await send2HourReminders();
        
        console.log('\n✅ Reminder job completed');
        console.log(`📊 Summary: ${result24h.sent} 24-hour, ${result2h.sent} 2-hour reminders sent`);
        
        return {
            reminders_24h: result24h.sent,
            reminders_2h: result2h.sent
        };
        
    } catch (error) {
        console.error('❌ Reminder job failed:', error);
        throw error;
    }
}

// Run if executed directly
if (require.main === module) {
    sendReminders()
        .then(result => {
            console.log('\n✅ Job completed:', result);
            process.exit(0);
        })
        .catch(error => {
            console.error('\n❌ Job failed:', error);
            process.exit(1);
        });
}

module.exports = { sendReminders, send24HourReminders, send2HourReminders };

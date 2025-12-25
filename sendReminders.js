/**
 * ═══════════════════════════════════════════════════════════
 * Appointment Reminder System
 * 
 * Sends WhatsApp reminders 24 hours before appointments
 * Run via cron every hour: node sendReminders.js
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const { sendWhatsAppMessage } = require('./utils/twilioClient');

const sql = neon(process.env.DATABASE_URL);

// Logger fallback
let logger;
try {
    logger = require('./utils/logger');
} catch (e) {
    logger = {
        info: (msg, data) => console.log('[INFO]', msg, data || ''),
        success: (msg, data) => console.log('[SUCCESS]', msg, data || ''),
        error: (msg, err) => console.error('[ERROR]', msg, err?.message || err),
    };
}

/**
 * Send reminders for appointments happening in ~24 hours
 */
async function sendReminders() {
    try {
        logger.info('Starting reminder job...');
        
        // Find confirmed appointments happening in 22-26 hours (4 hour window)
        const upcomingAppointments = await sql`
            SELECT 
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_date,
                a.appointment_time,
                a.reminder_sent,
                c.name as clinic_name,
                c.doctor_name,
                EXTRACT(EPOCH FROM (a.appointment_date - NOW())) / 3600 as hours_until
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE 
                a.status = 'confirmed'
                AND a.reminder_sent = false
                AND a.appointment_date > NOW()
                AND EXTRACT(EPOCH FROM (a.appointment_date - NOW())) / 3600 BETWEEN 22 AND 26
            ORDER BY a.appointment_date ASC
        `;
        
        if (upcomingAppointments.length === 0) {
            logger.info('No appointments need reminders');
            return { sent: 0 };
        }
        
        logger.info(`Found ${upcomingAppointments.length} appointments to remind`);
        
        let sentCount = 0;
        
        for (const appt of upcomingAppointments) {
            try {
                const appointmentDate = new Date(appt.appointment_date);
                const formattedDate = appointmentDate.toLocaleDateString('en-IN', {
                    weekday: 'long',
                    day: '2-digit',
                    month: 'long',
                    year: 'numeric',
                    timeZone: 'Asia/Kolkata'
                });
                
                const message = `🔔 *Appointment Reminder*\n\n` +
                    `You have an appointment tomorrow:\n\n` +
                    `📋 Booking #${appt.id}\n` +
                    `🏥 ${appt.clinic_name}\n` +
                    `👨‍⚕️ ${appt.doctor_name}\n` +
                    `📅 ${formattedDate}\n` +
                    `🕒 ${appt.appointment_time}\n\n` +
                    `⏰ Please arrive 10 minutes early.\n\n` +
                    `Need to reschedule? Contact the clinic.`;
                
                await sendWhatsAppMessage(appt.patient_phone, message);
                
                // Mark as sent
                await sql`
                    UPDATE appointments
                    SET 
                        reminder_sent = true,
                        reminder_sent_at = NOW(),
                        updated_at = NOW()
                    WHERE id = ${appt.id}
                `;
                
                logger.success(`Reminder sent for appointment #${appt.id}`, {
                    patient: appt.patient_name,
                    date: formattedDate
                });
                
                sentCount++;
                
                // Rate limiting - wait 2 seconds between messages
                await new Promise(resolve => setTimeout(resolve, 2000));
                
            } catch (error) {
                logger.error(`Failed to send reminder for appointment #${appt.id}`, error);
            }
        }
        
        logger.success(`Reminder job completed: ${sentCount}/${upcomingAppointments.length} sent`);
        
        return { sent: sentCount, total: upcomingAppointments.length };
        
    } catch (error) {
        logger.error('Reminder job failed', error);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════
// Run if called directly
// ═══════════════════════════════════════════════════════════

if (require.main === module) {
    sendReminders()
        .then(result => {
            console.log('✅ Reminder job completed:', result);
            process.exit(0);
        })
        .catch(error => {
            console.error('❌ Reminder job failed:', error);
            process.exit(1);
        });
}

module.exports = { sendReminders };

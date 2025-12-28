/**
 * ═══════════════════════════════════════════════════════════
 * PERSISTENT AUTO-APPROVAL SYSTEM
 * 
 * Problem: setTimeout() timers are lost on server restart
 * Solution: Store auto-approval deadline in database + cron job
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const twilio = require('twilio');

const sql = neon(process.env.DATABASE_URL);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const AUTO_APPROVAL_DELAY_MINUTES = parseInt(process.env.AUTO_APPROVAL_DELAY_MINUTES) || 1440; // Default: 1440 minutes (24 hours)

// ═══════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════
const log = {
    info: (msg, data = {}) => console.log(JSON.stringify({ 
        timestamp: new Date().toISOString(), 
        level: 'INFO', 
        message: msg, 
        ...data 
    })),
    success: (msg, data = {}) => console.log(JSON.stringify({ 
        timestamp: new Date().toISOString(), 
        level: 'SUCCESS', 
        message: msg, 
        ...data 
    })),
    error: (msg, error = {}) => console.error(JSON.stringify({ 
        timestamp: new Date().toISOString(), 
        level: 'ERROR', 
        message: msg, 
        error: error.message || String(error), 
        stack: error.stack || '' 
    }))
};

// ═══════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════
function normalizePhone(phone) {
    if (!phone) return '';
    return phone.replace('whatsapp:', '').trim();
}

function formatForWhatsApp(phone) {
    if (!phone) return '';
    const clean = normalizePhone(phone);
    return clean.startsWith('whatsapp:') ? clean : `whatsapp:${clean}`;
}

async function sendWhatsApp(to, message) {
    try {
        const phone = formatForWhatsApp(to);
        const msg = await twilioClient.messages.create({
            from: process.env.WABA_NUMBER,
            to: phone,
            body: message
        });
        log.info('WhatsApp sent', { to: normalizePhone(phone), sid: msg.sid });
        return true;
    } catch (error) {
        log.error('WhatsApp failed', error);
        return false;
    }
}

// ═══════════════════════════════════════════════════════════
// AUTO-APPROVAL PROCESSOR (Call this from CRON)
// ═══════════════════════════════════════════════════════════
async function processAutoApprovals() {
    try {
        log.info('Starting auto-approval check...');
        
        // Find appointments that are:
        // 1. Still pending
        // 2. Created more than X minutes ago
        // 3. Not yet auto-processed
        const cutoffTime = new Date(Date.now() - AUTO_APPROVAL_DELAY_MINUTES * 60 * 1000);
        
        const pendingAppts = await sql`
            SELECT 
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_date,
                a.appointment_time,
                a.created_at,
                c.name as clinic_name,
                c.doctor_name
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE a.status = 'pending'
            AND a.auto_processed = false
            AND a.created_at <= ${cutoffTime.toISOString()}
            ORDER BY a.created_at ASC
        `;
        
        if (pendingAppts.length === 0) {
            log.info('No appointments to auto-approve');
            return { processed: 0, approved: 0, errors: 0 };
        }
        
        log.info(`Found ${pendingAppts.length} appointment(s) to auto-approve`);
        
        let approved = 0;
        let errors = 0;
        
        for (const appt of pendingAppts) {
            try {
                // Update to confirmed
                await sql`
                    UPDATE appointments 
                    SET status = 'confirmed',
                        approved_at = NOW(),
                        auto_processed = true,
                        updated_at = NOW()
                    WHERE id = ${appt.id}
                `;
                
                const dateStr = new Date(appt.appointment_date).toLocaleDateString('en-IN', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric'
                });
                
                // Notify patient
                await sendWhatsApp(
                    appt.patient_phone,
                    `✅ *APPOINTMENT CONFIRMED!*\n\n━━━━━━━━━━━━━━━━━━━━━\n📋 *Booking:* #${appt.id}\n🏥 *Clinic:* ${appt.clinic_name}\n👨‍⚕️ *Doctor:* Dr. ${appt.doctor_name}\n📅 *Date:* ${dateStr}\n⏰ *Time:* ${appt.appointment_time}\n━━━━━━━━━━━━━━━━━━━━━\n\n✓ *Auto-approved* (doctor didn't respond)\n✓ Please arrive 10 minutes early\n\nSee you soon! 😊\n\n━━━━━━━━━━━━━━━━━━━━━\n*Need to change?*\n❌ CANCEL #${appt.id}\n🔄 RESCHEDULE #${appt.id}`
                );
                
                approved++;
                
                log.success('Auto-approved appointment', {
                    appointmentId: appt.id,
                    patient: appt.patient_name,
                    minutesElapsed: Math.floor((Date.now() - new Date(appt.created_at)) / 60000)
                });
                
            } catch (error) {
                errors++;
                log.error(`Failed to auto-approve #${appt.id}`, error);
            }
        }
        
        const result = {
            processed: pendingAppts.length,
            approved,
            errors
        };
        
        log.success('Auto-approval batch complete', result);
        return result;
        
    } catch (error) {
        log.error('Auto-approval process failed', error);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════
// RUN MANUALLY OR FROM CRON
// ═══════════════════════════════════════════════════════════
if (require.main === module) {
    // Run directly: node processAutoApprovals.js
    processAutoApprovals()
        .then(result => {
            console.log('\n✅ Auto-approval complete:');
            console.log(`   Processed: ${result.processed}`);
            console.log(`   Approved: ${result.approved}`);
            console.log(`   Errors: ${result.errors}\n`);
            process.exit(0);
        })
        .catch(error => {
            console.error('\n❌ Auto-approval failed:', error.message, '\n');
            process.exit(1);
        });
}

module.exports = { processAutoApprovals };

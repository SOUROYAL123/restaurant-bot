/**
 * ═══════════════════════════════════════════════════════════
 * Auto-Approval/Rejection Background Job
 * 
 * Automatically processes pending appointments after configured hours
 * Can auto-approve or auto-reject based on clinic settings
 * 
 * Run via: node autoApproval.js (or cron endpoint)
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
        warning: (msg, data) => console.log('[WARNING]', msg, data || ''),
        error: (msg, err) => console.error('[ERROR]', msg, err?.message || err),
    };
}

// Google Sheets Logger fallback
let GoogleSheetsLogger;
try {
    GoogleSheetsLogger = require('./utils/googleSheetsLogger');
} catch (e) {
    logger.warning('Google Sheets logger not available');
    GoogleSheetsLogger = {
        updateAppointmentStatus: async () => {}
    };
}

/**
 * Process auto-approval/rejection for overdue appointments
 */
async function processAutoApprovals() {
    try {
        logger.info('Starting auto-approval job...');
        
        // Find pending appointments that are past their auto-approval deadline
        const overdueAppointments = await sql`
            SELECT 
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_date,
                a.appointment_time,
                a.created_at,
                c.id as clinic_id,
                c.name as clinic_name,
                c.doctor_name,
                c.doctor_whatsapp,
                c.auto_approve,
                c.auto_approve_after_hours,
                c.auto_action,
                c.google_sheet_id,
                EXTRACT(EPOCH FROM (NOW() - a.created_at)) / 3600 as hours_pending
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE 
                a.status = 'pending'
                AND a.auto_processed = false
                AND c.auto_approve = true
                AND EXTRACT(EPOCH FROM (NOW() - a.created_at)) / 3600 >= c.auto_approve_after_hours
            ORDER BY a.created_at ASC
        `;
        
        if (overdueAppointments.length === 0) {
            logger.info('No appointments to auto-process');
            return { processed: 0 };
        }
        
        logger.info(`Found ${overdueAppointments.length} appointments to auto-process`);
        
        let processedCount = 0;
        
        for (const appt of overdueAppointments) {
            try {
                const isApprove = appt.auto_action === 'approve';
                const newStatus = isApprove ? 'confirmed' : 'rejected';
                const timestamp = new Date();
                
                logger.info(`Auto-${isApprove ? 'approving' : 'rejecting'} appointment #${appt.id}`, {
                    clinic: appt.clinic_name,
                    patient: appt.patient_name,
                    hours_pending: Math.round(appt.hours_pending)
                });
                
                // Update appointment status
                if (isApprove) {
                    await sql`
                        UPDATE appointments
                        SET 
                            status = 'confirmed',
                            approved_at = ${timestamp},
                            auto_processed = true,
                            auto_processed_at = ${timestamp},
                            updated_at = NOW()
                        WHERE id = ${appt.id}
                    `;
                } else {
                    await sql`
                        UPDATE appointments
                        SET 
                            status = 'rejected',
                            rejected_at = ${timestamp},
                            auto_processed = true,
                            auto_processed_at = ${timestamp},
                            updated_at = NOW()
                        WHERE id = ${appt.id}
                    `;
                }
                
                // Update Google Sheets
                if (appt.google_sheet_id) {
                    try {
                        await GoogleSheetsLogger.updateAppointmentStatus(
                            appt.google_sheet_id,
                            appt.id,
                            newStatus,
                            timestamp.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                            'AUTO-PROCESSED'
                        );
                    } catch (error) {
                        logger.warning('Google Sheets update failed', { error: error.message });
                    }
                }
                
                const formattedDate = new Date(appt.appointment_date).toLocaleDateString('en-IN', {
                    day: '2-digit',
                    month: 'long',
                    year: 'numeric',
                    timeZone: 'Asia/Kolkata'
                });
                
                // Notify patient
                const patientMessage = isApprove
                    ? `✅ *Appointment Auto-Confirmed*\n\n` +
                      `📋 Booking #${appt.id}\n` +
                      `🏥 ${appt.clinic_name}\n` +
                      `📅 ${formattedDate}\n` +
                      `🕒 ${appt.appointment_time}\n\n` +
                      `Your appointment has been automatically confirmed!\n` +
                      `Please arrive 10 minutes early.\n\n` +
                      `_(Auto-confirmed after ${appt.auto_approve_after_hours} hours)_`
                    : `❌ *Appointment Auto-Cancelled*\n\n` +
                      `📋 Booking #${appt.id}\n\n` +
                      `Your appointment request was automatically cancelled after ${appt.auto_approve_after_hours} hours.\n\n` +
                      `Please book a new appointment if still needed.\n\n` +
                      `Reply "hi" to book again.`;
                
                await sendWhatsAppMessage(appt.patient_phone, patientMessage);
                logger.success(`Patient notification sent for #${appt.id}`);
                
                // Notify doctor
                const doctorMessage = `⚠️ *Auto-${isApprove ? 'Approved' : 'Rejected'} Appointment*\n\n` +
                    `📋 ID: #${appt.id}\n` +
                    `👤 Patient: ${appt.patient_name}\n` +
                    `📅 Date: ${formattedDate}\n` +
                    `🕒 Time: ${appt.appointment_time}\n\n` +
                    `This appointment was automatically ${isApprove ? 'confirmed' : 'cancelled'} after ${appt.auto_approve_after_hours} hours of no response.\n\n` +
                    `Patient has been notified.`;
                
                await sendWhatsAppMessage(appt.doctor_whatsapp, doctorMessage);
                logger.success(`Doctor notification sent for #${appt.id}`);
                
                processedCount++;
                
            } catch (error) {
                logger.error(`Failed to auto-process appointment #${appt.id}`, error);
            }
        }
        
        logger.success(`Auto-approval job completed: ${processedCount}/${overdueAppointments.length} processed`);
        
        return {
            processed: processedCount,
            total: overdueAppointments.length
        };
        
    } catch (error) {
        logger.error('Auto-approval job failed', error);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════
// Run if called directly (for cron jobs)
// ═══════════════════════════════════════════════════════════

if (require.main === module) {
    processAutoApprovals()
        .then(result => {
            console.log('✅ Auto-approval job completed:', result);
            process.exit(0);
        })
        .catch(error => {
            console.error('❌ Auto-approval job failed:', error);
            process.exit(1);
        });
}

module.exports = { processAutoApprovals };

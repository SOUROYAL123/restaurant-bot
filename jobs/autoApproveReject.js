require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const { sendWhatsAppMessage } = require('../utils/twilioClient');
const GoogleSheetsLogger = require('../utils/googleSheetsLogger');

const sql = neon(process.env.DATABASE_URL);

/**
 * Auto-approve pending appointments based on clinic settings
 * Run this every hour via cron
 */
async function autoApproveAppointments() {
    try {
        console.log('🔄 Running auto-approval check...');
        
        const toApprove = await sql`
            SELECT 
                a.id,
                a.clinic_id,
                a.patient_name,
                a.patient_phone,
                a.appointment_date,
                a.appointment_time,
                c.name as clinic_name,
                c.google_sheet_id,
                c.auto_approve_after_hours
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE a.status = 'pending'
            AND c.auto_approve = true
            AND a.created_at < NOW() - (c.auto_approve_after_hours || ' hours')::INTERVAL
        `;
        
        console.log(`📊 Found ${toApprove.length} appointments to auto-approve`);
        
        for (const appt of toApprove) {
            // Update appointment
            await sql`
                UPDATE appointments 
                SET 
                    status = 'confirmed',
                    approved_at = NOW(),
                    auto_approved = true
                WHERE id = ${appt.id}
            `;
            
            // Update Google Sheets
            if (appt.google_sheet_id) {
                await GoogleSheetsLogger.updateAppointmentStatus(
                    appt.google_sheet_id,
                    appt.id,
                    'confirmed (auto)',
                    new Date().toLocaleString('en-IN')
                );
            }
            
            // Notify patient
            const message = `✅ *Appointment Confirmed*\n\n` +
                `📋 Booking #${appt.id}\n` +
                `🏥 ${appt.clinic_name}\n` +
                `📅 ${appt.appointment_date}\n` +
                `🕒 ${appt.appointment_time}\n\n` +
                `Your appointment has been automatically confirmed!\n\n` +
                `Please arrive 10 minutes early.`;
            
            await sendWhatsAppMessage(appt.patient_phone, message);
            
            console.log(`✅ Auto-approved appointment #${appt.id}`);
        }
        
        return toApprove.length;
        
    } catch (error) {
        console.error('❌ Auto-approval error:', error.message);
        throw error;
    }
}

/**
 * Auto-reject old pending appointments
 */
async function autoRejectAppointments() {
    try {
        console.log('🔄 Running auto-rejection check...');
        
        const toReject = await sql`
            SELECT 
                a.id,
                a.clinic_id,
                a.patient_name,
                a.patient_phone,
                a.appointment_date,
                a.appointment_time,
                c.name as clinic_name,
                c.google_sheet_id,
                c.auto_reject_after_hours
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE a.status = 'pending'
            AND c.auto_reject = true
            AND a.created_at < NOW() - (c.auto_reject_after_hours || ' hours')::INTERVAL
        `;
        
        console.log(`📊 Found ${toReject.length} appointments to auto-reject`);
        
        for (const appt of toReject) {
            // Update appointment
            await sql`
                UPDATE appointments 
                SET 
                    status = 'rejected',
                    rejected_at = NOW(),
                    auto_rejected = true
                WHERE id = ${appt.id}
            `;
            
            // Update Google Sheets
            if (appt.google_sheet_id) {
                await GoogleSheetsLogger.updateAppointmentStatus(
                    appt.google_sheet_id,
                    appt.id,
                    'rejected (timeout)',
                    new Date().toLocaleString('en-IN')
                );
            }
            
            // Notify patient
            const message = `❌ *Appointment Expired*\n\n` +
                `📋 Booking #${appt.id}\n` +
                `🏥 ${appt.clinic_name}\n` +
                `📅 ${appt.appointment_date}\n` +
                `🕒 ${appt.appointment_time}\n\n` +
                `Your appointment request has expired.\n\n` +
                `Please book again if you still need an appointment.\n` +
                `Reply "1" to start booking.`;
            
            await sendWhatsAppMessage(appt.patient_phone, message);
            
            console.log(`❌ Auto-rejected appointment #${appt.id}`);
        }
        
        return toReject.length;
        
    } catch (error) {
        console.error('❌ Auto-rejection error:', error.message);
        throw error;
    }
}

/**
 * Main function - run both
 */
async function runAutoApprovalRejection() {
    try {
        console.log('🤖 Starting Auto-Approval/Rejection Job\n');
        console.log(`⏰ Time: ${new Date().toLocaleString('en-IN')}\n`);
        
        const approved = await autoApproveAppointments();
        const rejected = await autoRejectAppointments();
        
        console.log('\n📈 Summary:');
        console.log(`  ✅ Auto-approved: ${approved}`);
        console.log(`  ❌ Auto-rejected: ${rejected}`);
        console.log('\n✅ Job completed successfully\n');
        
    } catch (error) {
        console.error('❌ Job failed:', error);
        throw error;
    }
}

// Run if executed directly
if (require.main === module) {
    runAutoApprovalRejection()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error);
            process.exit(1);
        });
}

module.exports = { runAutoApprovalRejection };

// handlers/patientCancellation.js
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { sendWhatsAppMessage } = require('../utils/twilioClient');
const GoogleSheetsLogger = require('../utils/googleSheetsLogger');

async function handlePatientCancellation(userPhone, clinicId, message, twiml) {
    const normalized = message.trim().toUpperCase();
    
    if (!normalized.startsWith('CANCEL ')) {
        return false;
    }
    
    const appointmentId = normalized.replace('CANCEL ', '').trim();
    
    try {
        const appointments = await sql`
            SELECT a.*, cl.google_sheet_id, cl.doctor_whatsapp, d.name as doctor_name
            FROM appointments a
            JOIN clinics cl ON a.clinic_id = cl.id
            LEFT JOIN doctors d ON a.doctor_id = d.id
            WHERE a.id = ${appointmentId}
            AND a.patient_phone = ${userPhone}
            AND a.clinic_id = ${clinicId}
            AND a.status IN ('pending', 'confirmed')
            LIMIT 1
        `;
        
        if (appointments.length === 0) {
            twiml.message(`❌ Appointment #${appointmentId} not found or already cancelled.`);
            return true;
        }
        
        const appointment = appointments[0];
        const now = new Date();
        const deadline = new Date(appointment.cancellation_deadline);
        
        // Check 24-hour window
        if (now > deadline) {
            twiml.message(
                `❌ *Cannot Cancel*\n\n` +
                `Appointment #${appointmentId}\n\n` +
                `⚠️ Cancellation deadline passed.\n` +
                `You must cancel 24 hours before the appointment.\n\n` +
                `Please contact the clinic directly.`
            );
            return true;
        }
        
        // Cancel appointment
        await sql`
            UPDATE appointments 
            SET status = 'cancelled', 
                updated_at = NOW()
            WHERE id = ${appointmentId}
        `;
        
        // Update Google Sheets
        if (appointment.google_sheet_id) {
            await GoogleSheetsLogger.updateAppointmentStatus(
                appointment.google_sheet_id,
                appointmentId,
                'cancelled (patient)'
            );
        }
        
        // Notify doctor
        if (appointment.doctor_whatsapp) {
            const doctorMessage = `🔔 *Appointment Cancelled by Patient*\n\n` +
                `📋 ID: #${appointmentId}\n` +
                `👤 Patient: ${appointment.patient_name}\n` +
                `📅 Date: ${appointment.appointment_date}\n` +
                `⏰ Time: ${appointment.appointment_time}`;
            
            await sendWhatsAppMessage(appointment.doctor_whatsapp, doctorMessage);
        }
        
        twiml.message(
            `✅ *Appointment Cancelled*\n\n` +
            `📋 Booking #${appointmentId}\n` +
            `📅 Date: ${appointment.appointment_date}\n` +
            `⏰ Time: ${appointment.appointment_time}\n\n` +
            `Your appointment has been cancelled successfully.\n\n` +
            `Reply 1 to book a new appointment.`
        );
        
        return true;
        
    } catch (error) {
        console.error('Error cancelling appointment:', error);
        twiml.message('❌ Error cancelling appointment. Please try again.');
        return true;
    }
}

module.exports = {
    handlePatientCancellation
};

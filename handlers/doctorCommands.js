// handlers/doctorCommands.js
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { sendWhatsAppMessage } = require('../utils/twilioClient');
const GoogleSheetsLogger = require('../utils/googleSheetsLogger');

async function handleDoctorCommands(userPhone, clinicId, message, twiml) {
    const normalizedMessage = message.trim().toUpperCase();
    
    // Check if user is a registered doctor
    const doctors = await sql`
        SELECT * FROM doctors 
        WHERE whatsapp = ${userPhone} 
        AND clinic_id = ${clinicId}
        AND status = 'active'
        LIMIT 1
    `;
    
    if (doctors.length === 0) {
        return false; // Not a doctor
    }
    
    const doctor = doctors[0];
    
    // AUTO ON - Enable auto-approval
    if (normalizedMessage === 'AUTO ON') {
        await toggleAutoApproval(clinicId, true, twiml);
        return true;
    }
    
    // AUTO OFF - Disable auto-approval
    if (normalizedMessage === 'AUTO OFF') {
        await toggleAutoApproval(clinicId, false, twiml);
        return true;
    }
    
    // AUTO STATUS - Check auto-approval status
    if (normalizedMessage === 'AUTO STATUS') {
        await checkAutoStatus(clinicId, twiml);
        return true;
    }
    
    // APPROVE command
    if (normalizedMessage.startsWith('APPROVE #')) {
        const appointmentId = normalizedMessage.replace('APPROVE #', '').trim();
        await approveAppointment(doctor, appointmentId, clinicId, twiml);
        return true;
    }
    
    // REJECT command
    if (normalizedMessage.startsWith('REJECT #')) {
        const appointmentId = normalizedMessage.replace('REJECT #', '').trim();
        await rejectAppointment(doctor, appointmentId, clinicId, twiml);
        return true;
    }
    
    // CANCEL command (doctor initiated)
    if (normalizedMessage.startsWith('CANCEL #')) {
        const appointmentId = normalizedMessage.replace('CANCEL #', '').trim();
        await cancelAppointment(doctor, appointmentId, clinicId, twiml);
        return true;
    }
    
    // PENDING command
    if (normalizedMessage === 'PENDING') {
        await showPendingAppointments(doctor, twiml);
        return true;
    }
    
    // TODAY command
    if (normalizedMessage === 'TODAY') {
        await showTodayAppointments(doctor, twiml);
        return true;
    }
    
    // HELP command
    if (normalizedMessage === 'HELP' || normalizedMessage === 'COMMANDS') {
        showDoctorHelp(twiml);
        return true;
    }
    
    return false;
}

async function toggleAutoApproval(clinicId, enabled, twiml) {
    try {
        await sql`
            UPDATE clinics 
            SET auto_approve = ${enabled}, 
                updated_at = NOW()
            WHERE id = ${clinicId}
        `;
        
        const status = enabled ? 'ENABLED' : 'DISABLED';
        const emoji = enabled ? '✅' : '❌';
        
        twiml.message(
            `${emoji} *Auto-Approval ${status}*\n\n` +
            (enabled 
                ? `All new appointments will be automatically confirmed.\n\n` +
                  `You can still:\n` +
                  `• View appointments: TODAY\n` +
                  `• Cancel appointments: CANCEL #id`
                : `New appointments will require manual approval.\n\n` +
                  `Use these commands:\n` +
                  `• APPROVE #id - to approve\n` +
                  `• REJECT #id - to reject\n` +
                  `• PENDING - view pending`
            )
        );
        
    } catch (error) {
        console.error('Error toggling auto-approval:', error);
        twiml.message('❌ Error updating settings. Please try again.');
    }
}

async function checkAutoStatus(clinicId, twiml) {
    try {
        const clinic = await sql`
            SELECT auto_approve FROM clinics WHERE id = ${clinicId} LIMIT 1
        `;
        
        const autoApprove = clinic[0]?.auto_approve || false;
        const status = autoApprove ? 'ENABLED ✅' : 'DISABLED ❌';
        
        twiml.message(
            `⚙️ *Auto-Approval Status*\n\n` +
            `Current Status: ${status}\n\n` +
            `To change:\n` +
            `• Reply AUTO ON to enable\n` +
            `• Reply AUTO OFF to disable`
        );
        
    } catch (error) {
        console.error('Error checking auto status:', error);
        twiml.message('❌ Error checking status.');
    }
}

async function approveAppointment(doctor, appointmentId, clinicId, twiml) {
    try {
        const appointments = await sql`
            SELECT a.*, c.name as customer_name, c.whatsapp as customer_phone, cl.google_sheet_id
            FROM appointments a
            JOIN customers c ON a.customer_id = c.id
            JOIN clinics cl ON a.clinic_id = cl.id
            WHERE a.id = ${appointmentId}
            AND a.doctor_id = ${doctor.id}
            AND a.status = 'pending'
            LIMIT 1
        `;
        
        if (appointments.length === 0) {
            twiml.message('❌ Appointment not found or already processed.');
            return;
        }
        
        const appointment = appointments[0];
        
        await sql`
            UPDATE appointments 
            SET status = 'confirmed', 
                updated_at = NOW()
            WHERE id = ${appointmentId}
        `;
        
        // Update Google Sheets
        if (appointment.google_sheet_id) {
            await GoogleSheetsLogger.updateAppointmentStatus(
                appointment.google_sheet_id,
                appointmentId,
                'confirmed',
                new Date().toLocaleString('en-IN')
            );
        }
        
        // Notify customer
        const customerMessage = `✅ *Appointment Confirmed*\n\n` +
            `📅 Date: ${appointment.appointment_date}\n` +
            `⏰ Time: ${appointment.appointment_time}\n` +
            `👨‍⚕️ Doctor: ${doctor.name}\n\n` +
            `Your appointment has been confirmed by the doctor.\n\n` +
            `Please arrive 10 minutes early.\n\n` +
            `❗ To cancel: Reply CANCEL ${appointmentId}\n` +
            `(Must cancel 24 hours before)`;
        
        await sendWhatsAppMessage(appointment.customer_phone, customerMessage);
        
        twiml.message(
            `✅ *Appointment #${appointmentId} Approved*\n\n` +
            `Patient: ${appointment.customer_name}\n` +
            `Date: ${appointment.appointment_date}\n` +
            `Time: ${appointment.appointment_time}\n\n` +
            `Customer has been notified.`
        );
        
    } catch (error) {
        console.error('Error approving appointment:', error);
        twiml.message('❌ Error approving appointment. Please try again.');
    }
}

async function cancelAppointment(doctor, appointmentId, clinicId, twiml) {
    try {
        const appointments = await sql`
            SELECT a.*, c.name as customer_name, c.whatsapp as customer_phone, cl.google_sheet_id
            FROM appointments a
            JOIN customers c ON a.customer_id = c.id
            JOIN clinics cl ON a.clinic_id = cl.id
            WHERE a.id = ${appointmentId}
            AND a.doctor_id = ${doctor.id}
            AND a.status IN ('pending', 'confirmed')
            LIMIT 1
        `;
        
        if (appointments.length === 0) {
            twiml.message('❌ Appointment not found.');
            return;
        }
        
        const appointment = appointments[0];
        
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
                'cancelled (doctor)'
            );
        }
        
        // Notify customer
        const customerMessage = `❌ *Appointment Cancelled*\n\n` +
            `📋 Booking #${appointmentId}\n` +
            `📅 Date: ${appointment.appointment_date}\n` +
            `⏰ Time: ${appointment.appointment_time}\n\n` +
            `Your appointment has been cancelled by the doctor.\n\n` +
            `Reply 1 to book a new appointment.`;
        
        await sendWhatsAppMessage(appointment.customer_phone, customerMessage);
        
        twiml.message(
            `✅ *Appointment #${appointmentId} Cancelled*\n\n` +
            `Patient: ${appointment.customer_name}\n` +
            `Customer has been notified.`
        );
        
    } catch (error) {
        console.error('Error cancelling appointment:', error);
        twiml.message('❌ Error cancelling appointment.');
    }
}

function showDoctorHelp(twiml) {
    const message = `👨‍⚕️ *Doctor Commands*\n\n` +
        `📋 *Appointments:*\n` +
        `PENDING - View pending requests\n` +
        `TODAY - View today's schedule\n` +
        `APPROVE #[id] - Approve request\n` +
        `REJECT #[id] - Reject request\n` +
        `CANCEL #[id] - Cancel appointment\n\n` +
        `⚙️ *Auto-Approval:*\n` +
        `AUTO ON - Enable auto-approval\n` +
        `AUTO OFF - Disable auto-approval\n` +
        `AUTO STATUS - Check status\n\n` +
        `HELP - Show this message`;
    
    twiml.message(message);
}

// Export other functions...
module.exports = {
    handleDoctorCommands
};

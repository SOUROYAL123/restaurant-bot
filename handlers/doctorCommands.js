// handlers/doctorCommands.js
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { sendWhatsAppMessage } = require('../utils/twilioClient');

/**
 * Handle doctor commands
 */
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
    
    // APPROVE command: APPROVE #123
    if (normalizedMessage.startsWith('APPROVE #')) {
        const appointmentId = normalizedMessage.replace('APPROVE #', '').trim();
        await approveAppointment(doctor, appointmentId, twiml);
        return true;
    }
    
    // REJECT command: REJECT #123
    if (normalizedMessage.startsWith('REJECT #')) {
        const appointmentId = normalizedMessage.replace('REJECT #', '').trim();
        await rejectAppointment(doctor, appointmentId, twiml);
        return true;
    }
    
    // PENDING command: Show all pending appointments
    if (normalizedMessage === 'PENDING') {
        await showPendingAppointments(doctor, twiml);
        return true;
    }
    
    // TODAY command: Show today's approved appointments
    if (normalizedMessage === 'TODAY') {
        await showTodayAppointments(doctor, twiml);
        return true;
    }
    
    // HELP command: Show doctor commands
    if (normalizedMessage === 'HELP' || normalizedMessage === 'COMMANDS') {
        showDoctorHelp(twiml);
        return true;
    }
    
    return false; // Not a recognized doctor command
}

/**
 * Approve appointment
 */
async function approveAppointment(doctor, appointmentId, twiml) {
    try {
        // Get appointment details
        const appointments = await sql`
            SELECT a.*, c.name as customer_name, c.whatsapp as customer_phone
            FROM appointments a
            JOIN customers c ON a.customer_id = c.id
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
        
        // Update appointment status
        await sql`
            UPDATE appointments 
            SET status = 'confirmed', 
                updated_at = NOW()
            WHERE id = ${appointmentId}
        `;
        
        // Notify customer
        const customerMessage = `✅ *Appointment Confirmed*\n\n` +
            `📅 Date: ${appointment.appointment_date}\n` +
            `⏰ Time: ${appointment.appointment_time}\n` +
            `👨‍⚕️ Doctor: ${doctor.name}\n\n` +
            `Your appointment has been confirmed by the doctor.\n\n` +
            `Please arrive 10 minutes early.`;
        
        await sendWhatsAppMessage(appointment.customer_phone, customerMessage);
        
        // Confirm to doctor
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

/**
 * Reject appointment
 */
async function rejectAppointment(doctor, appointmentId, twiml) {
    try {
        // Get appointment details
        const appointments = await sql`
            SELECT a.*, c.name as customer_name, c.whatsapp as customer_phone
            FROM appointments a
            JOIN customers c ON a.customer_id = c.id
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
        
        // Update appointment status
        await sql`
            UPDATE appointments 
            SET status = 'cancelled', 
                updated_at = NOW()
            WHERE id = ${appointmentId}
        `;
        
        // Notify customer
        const customerMessage = `❌ *Appointment Not Available*\n\n` +
            `📅 Date: ${appointment.appointment_date}\n` +
            `⏰ Time: ${appointment.appointment_time}\n\n` +
            `Unfortunately, this slot is no longer available.\n\n` +
            `Reply with 1 to book a different time.`;
        
        await sendWhatsAppMessage(appointment.customer_phone, customerMessage);
        
        // Confirm to doctor
        twiml.message(
            `❌ *Appointment #${appointmentId} Rejected*\n\n` +
            `Patient: ${appointment.customer_name}\n` +
            `Date: ${appointment.appointment_date}\n` +
            `Time: ${appointment.appointment_time}\n\n` +
            `Customer has been notified.`
        );
        
    } catch (error) {
        console.error('Error rejecting appointment:', error);
        twiml.message('❌ Error rejecting appointment. Please try again.');
    }
}

/**
 * Show pending appointments
 */
async function showPendingAppointments(doctor, twiml) {
    try {
        const appointments = await sql`
            SELECT a.*, c.name as customer_name, c.whatsapp as customer_phone
            FROM appointments a
            JOIN customers c ON a.customer_id = c.id
            WHERE a.doctor_id = ${doctor.id}
            AND a.status = 'pending'
            ORDER BY a.appointment_date, a.appointment_time
            LIMIT 10
        `;
        
        if (appointments.length === 0) {
            twiml.message('✅ No pending appointments.');
            return;
        }
        
        let message = `📋 *Pending Appointments*\n\n`;
        
        appointments.forEach(apt => {
            message += `#${apt.id} - ${apt.customer_name}\n`;
            message += `📅 ${apt.appointment_date} ⏰ ${apt.appointment_time}\n`;
            message += `📞 ${apt.customer_phone.replace('whatsapp:', '')}\n`;
            message += `---\n`;
        });
        
        message += `\n💡 Reply:\n`;
        message += `APPROVE #[id] - to approve\n`;
        message += `REJECT #[id] - to reject`;
        
        twiml.message(message);
        
    } catch (error) {
        console.error('Error showing pending appointments:', error);
        twiml.message('❌ Error fetching appointments.');
    }
}

/**
 * Show today's appointments
 */
async function showTodayAppointments(doctor, twiml) {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        const appointments = await sql`
            SELECT a.*, c.name as customer_name, c.whatsapp as customer_phone
            FROM appointments a
            JOIN customers c ON a.customer_id = c.id
            WHERE a.doctor_id = ${doctor.id}
            AND a.appointment_date = ${today}
            AND a.status = 'confirmed'
            ORDER BY a.appointment_time
        `;
        
        if (appointments.length === 0) {
            twiml.message(`📅 No appointments scheduled for today (${today}).`);
            return;
        }
        
        let message = `📅 *Today's Appointments* (${today})\n\n`;
        
        appointments.forEach(apt => {
            message += `⏰ ${apt.appointment_time} - ${apt.customer_name}\n`;
            message += `📞 ${apt.customer_phone.replace('whatsapp:', '')}\n`;
            message += `---\n`;
        });
        
        twiml.message(message);
        
    } catch (error) {
        console.error('Error showing today appointments:', error);
        twiml.message('❌ Error fetching appointments.');
    }
}

/**
 * Show doctor help commands
 */
function showDoctorHelp(twiml) {
    const message = `👨‍⚕️ *Doctor Commands*\n\n` +
        `PENDING - View pending appointments\n` +
        `TODAY - View today's schedule\n` +
        `APPROVE #[id] - Approve appointment\n` +
        `REJECT #[id] - Reject appointment\n` +
        `HELP - Show this message\n\n` +
        `Example: APPROVE #123`;
    
    twiml.message(message);
}

module.exports = {
    handleDoctorCommands
};

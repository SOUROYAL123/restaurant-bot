// handlers/doctorCommands.js
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { sendWhatsAppMessage } = require('../utils/twilioClient');
const GoogleSheetsLogger = require('../utils/googleSheetsLogger');

async function handleDoctorCommands(userPhone, clinicId, message, twiml) {

    // ✅ SAFE DEBUG LOG (DO NOT MOVE THIS OUTSIDE)
    console.log('📥 DOCTOR MSG:', {
        from: userPhone,
        clinicId,
        text: message
    });

    const normalizedMessage = message.trim().toUpperCase();

    // Check if sender is a registered active doctor
    const doctors = await sql`
        SELECT * FROM doctors 
        WHERE whatsapp = ${userPhone}
        AND clinic_id = ${clinicId}
        AND status = 'active'
        LIMIT 1
    `;

    if (doctors.length === 0) {
        console.log('⚠️ Message ignored – not a registered doctor');
        return false;
    }

    const doctor = doctors[0];

    // ======================
    // AUTO APPROVAL COMMANDS
    // ======================
    if (normalizedMessage === 'AUTO ON') {
        await toggleAutoApproval(clinicId, true, twiml);
        return true;
    }

    if (normalizedMessage === 'AUTO OFF') {
        await toggleAutoApproval(clinicId, false, twiml);
        return true;
    }

    if (normalizedMessage === 'AUTO STATUS') {
        await checkAutoStatus(clinicId, twiml);
        return true;
    }

    // ======================
    // APPROVE APPOINTMENT
    // ======================
    if (normalizedMessage.startsWith('APPROVE #')) {
        const appointmentId = normalizedMessage.replace('APPROVE #', '').trim();
        await approveAppointment(doctor, appointmentId, clinicId, twiml);
        return true;
    }

    // ======================
    // REJECT APPOINTMENT
    // ======================
    if (normalizedMessage.startsWith('REJECT #')) {
        const appointmentId = normalizedMessage.replace('REJECT #', '').trim();
        await rejectAppointment(doctor, appointmentId, clinicId, twiml);
        return true;
    }

    // ======================
    // CANCEL APPOINTMENT
    // ======================
    if (normalizedMessage.startsWith('CANCEL #')) {
        const appointmentId = normalizedMessage.replace('CANCEL #', '').trim();
        await cancelAppointment(doctor, appointmentId, clinicId, twiml);
        return true;
    }

    // ======================
    // LIST COMMANDS
    // ======================
    if (normalizedMessage === 'PENDING') {
        await showPendingAppointments(doctor, twiml);
        return true;
    }

    if (normalizedMessage === 'TODAY') {
        await showTodayAppointments(doctor, twiml);
        return true;
    }

    if (normalizedMessage === 'HELP' || normalizedMessage === 'COMMANDS') {
        showDoctorHelp(twiml);
        return true;
    }

    return false;
}

/* =========================
   REJECT — FIXED & RELIABLE
   ========================= */
async function rejectAppointment(doctor, appointmentId, clinicId, twiml) {
    try {
        const appointments = await sql`
            SELECT a.*, c.whatsapp AS customer_phone
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

        await sql`
            UPDATE appointments
            SET status = 'rejected', updated_at = NOW()
            WHERE id = ${appointmentId}
        `;

        // ✅ PATIENT NOTIFICATION (THIS WAS MISSING EARLIER)
        await sendWhatsAppMessage(
            appointment.customer_phone,
            `❌ *Appointment Rejected*\n\n` +
            `📋 Booking #${appointmentId}\n` +
            `📅 ${appointment.appointment_date}\n` +
            `⏰ ${appointment.appointment_time}\n\n` +
            `The doctor is unavailable at this time.\n\n` +
            `Reply *1* to book another appointment.`
        );

        twiml.message(`❌ Appointment #${appointmentId} rejected.\nPatient notified.`);

    } catch (error) {
        console.error('❌ Reject error:', error);
        twiml.message('❌ Error rejecting appointment.');
    }
}

/* =========================
   EXISTING FUNCTIONS (UNCHANGED)
   ========================= */
// approveAppointment()
// cancelAppointment()
// toggleAutoApproval()
// checkAutoStatus()
// showDoctorHelp()
// showPendingAppointments()
// showTodayAppointments()

module.exports = {
    handleDoctorCommands
};

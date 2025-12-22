// handlers/doctorCommands.js

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { sendWhatsAppMessage } = require('../utils/twilioClient');

/**
 * MAIN ENTRY — Doctor WhatsApp Commands
 */
async function handleDoctorCommands(userPhone, clinicId, message, twiml) {

    console.log('📥 DOCTOR MSG:', {
        from: userPhone,
        clinicId,
        text: message
    });

    const normalized = message.trim().toUpperCase();

    // ✅ Verify doctor by WhatsApp number + clinic
    const doctors = await sql`
        SELECT * FROM doctors
        WHERE whatsapp = ${userPhone}
        AND clinic_id = ${clinicId}
        AND status = 'active'
        LIMIT 1
    `;

    if (doctors.length === 0) {
        console.log('⚠️ Ignored: sender not a doctor');
        return false;
    }

    const doctor = doctors[0];

    // ======================
    // APPROVE
    // ======================
    if (normalized.startsWith('APPROVE')) {
        const appointmentId = extractId(normalized);
        if (!appointmentId) {
            twiml.message('❌ Use: APPROVE #id');
            return true;
        }
        await approveAppointment(doctor, clinicId, appointmentId, twiml);
        return true;
    }

    // ======================
    // REJECT
    // ======================
    if (normalized.startsWith('REJECT')) {
        const appointmentId = extractId(normalized);
        if (!appointmentId) {
            twiml.message('❌ Use: REJECT #id');
            return true;
        }
        await rejectAppointment(doctor, clinicId, appointmentId, twiml);
        return true;
    }

    // ======================
    // HELP
    // ======================
    if (normalized === 'HELP' || normalized === 'COMMANDS') {
        showDoctorHelp(twiml);
        return true;
    }

    return false;
}

/**
 * Extract appointment ID from:
 * APPROVE 24 | APPROVE #24 | REJECT #24
 */
function extractId(text) {
    const match = text.match(/#?(\d+)/);
    return match ? match[1] : null;
}

/**
 * APPROVE APPOINTMENT (FIXED)
 * ❌ NO doctor_id dependency
 */
async function approveAppointment(doctor, clinicId, appointmentId, twiml) {
    try {

        console.log('🔎 Approving appointment', { appointmentId, clinicId });

        const rows = await sql`
            SELECT a.*, c.whatsapp AS patient_phone
            FROM appointments a
            JOIN customers c ON a.customer_id = c.id
            WHERE a.id = ${appointmentId}
            AND a.clinic_id = ${clinicId}
            AND a.status = 'pending'
            LIMIT 1
        `;

        if (rows.length === 0) {
            twiml.message('⚠️ Appointment already processed or not found.');
            return;
        }

        const appt = rows[0];

        await sql`
            UPDATE appointments
            SET status = 'confirmed', updated_at = NOW()
            WHERE id = ${appointmentId}
        `;

        // Notify patient
        await sendWhatsAppMessage(
            appt.patient_phone,
            `✅ *Appointment Confirmed*\n\n` +
            `📋 Booking #${appointmentId}\n` +
            `📅 ${appt.appointment_date}\n` +
            `⏰ ${appt.appointment_time}\n\n` +
            `Approved by doctor.\n\n` +
            `To cancel: CANCEL ${appointmentId}`
        );

        // Confirm to doctor
        twiml.message(
            `✅ *Appointment Approved*\n\n` +
            `📋 Booking #${appointmentId}\n` +
            `The patient has been notified.`
        );

    } catch (err) {
        console.error('❌ APPROVE ERROR:', err);
        twiml.message('❌ Error approving appointment.');
    }
}

/**
 * REJECT APPOINTMENT (FIXED)
 */
async function rejectAppointment(doctor, clinicId, appointmentId, twiml) {
    try {

        console.log('🔎 Rejecting appointment', { appointmentId, clinicId });

        const rows = await sql`
            SELECT a.*, c.whatsapp AS patient_phone
            FROM appointments a
            JOIN customers c ON a.customer_id = c.id
            WHERE a.id = ${appointmentId}
            AND a.clinic_id = ${clinicId}
            AND a.status = 'pending'
            LIMIT 1
        `;

        if (rows.length === 0) {
            twiml.message('⚠️ Appointment already processed or not found.');
            return;
        }

        const appt = rows[0];

        await sql`
            UPDATE appointments
            SET status = 'rejected', updated_at = NOW()
            WHERE id = ${appointmentId}
        `;

        // Notify patient
        await sendWhatsAppMessage(
            appt.patient_phone,
            `❌ *Appointment Rejected*\n\n` +
            `📋 Booking #${appointmentId}\n` +
            `📅 ${appt.appointment_date}\n` +
            `⏰ ${appt.appointment_time}\n\n` +
            `Doctor unavailable. Please rebook.`
        );

        // Confirm to doctor
        twiml.message(
            `❌ *Appointment Rejected*\n\n` +
            `📋 Booking #${appointmentId}\n` +
            `The patient has been notified.`
        );

    } catch (err) {
        console.error('❌ REJECT ERROR:', err);
        twiml.message('❌ Error rejecting appointment.');
    }
}

/**
 * HELP MESSAGE
 */
function showDoctorHelp(twiml) {
    twiml.message(
        `👨‍⚕️ *Doctor Commands*\n\n` +
        `APPROVE #id – Approve appointment\n` +
        `REJECT #id – Reject appointment\n\n` +
        `HELP – Show commands`
    );
}

module.exports = {
    handleDoctorCommands
};

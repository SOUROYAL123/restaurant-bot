// handlers/doctorCommands.js
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { sendWhatsAppMessage } = require('../utils/twilioClient');
const GoogleSheetsLogger = require('../utils/googleSheetsLogger');

/**
 * MAIN ENTRY — Doctor WhatsApp Commands
 */
async function handleDoctorCommands(userPhone, clinicId, message, twiml) {

    // 🔍 DEBUG LOG (SAFE)
    console.log('📥 DOCTOR MSG:', {
        from: userPhone,
        clinicId,
        text: message
    });

    const normalizedMessage = message.trim().toUpperCase();

    // ✅ Verify doctor identity
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
    // APPROVE
    // ======================
    if (normalizedMessage.startsWith('APPROVE')) {
        const appointmentId = extractId(normalizedMessage);
        if (!appointmentId) {
            twiml.message('❌ Use: APPROVE #id');
            return true;
        }
        await approveAppointment(doctor, appointmentId, twiml);
        return true;
    }

    // ======================
    // REJECT
    // ======================
    if (normalizedMessage.startsWith('REJECT')) {
        const appointmentId = extractId(normalizedMessage);
        if (!appointmentId) {
            twiml.message('❌ Use: REJECT #id');
            return true;
        }
        await rejectAppointment(doctor, appointmentId, twiml);
        return true;
    }

    // ======================
    // CANCEL
    // ======================
    if (normalizedMessage.startsWith('CANCEL')) {
        const appointmentId = extractId(normalizedMessage);
        if (!appointmentId) {
            twiml.message('❌ Use: CANCEL #id');
            return true;
        }
        await cancelAppointment(doctor, appointmentId, twiml);
        return true;
    }

    // ======================
    // HELP
    // ======================
    if (normalizedMessage === 'HELP' || normalizedMessage === 'COMMANDS') {
        showDoctorHelp(twiml);
        return true;
    }

    return false;
}

/**
 * Extract appointment ID from messages like:
 * APPROVE 22 | APPROVE #22 | REJECT #22
 */
function extractId(text) {
    const match = text.match(/#?(\d+)/);
    return match ? match[1] : null;
}

/**
 * APPROVE APPOINTMENT
 */
async function approveAppointment(doctor, appointmentId, twiml) {
    try {
        const rows = await sql`
            SELECT a.*, c.whatsapp AS customer_phone
            FROM appointments a
            JOIN customers c ON a.customer_id = c.id
            WHERE a.id = ${appointmentId}
            AND a.doctor_id = ${doctor.id}
            AND a.status = 'pending'
            LIMIT 1
        `;

        if (rows.length === 0) {
            twiml.message('❌ Appointment not found or already processed.');
            return;
        }

        const appt = rows[0];

        await sql`
            UPDATE appointments
            SET status = 'confirmed', updated_at = NOW()
            WHERE id = ${appointmentId}
        `;

        await sendWhatsAppMessage(
            appt.customer_phone,
            `✅ *Appointment Confirmed*\n\n` +
            `📋 Booking #${appointmentId}\n` +
            `📅 ${appt.appointment_date}\n` +
            `⏰ ${appt.appointment_time}\n\n` +
            `Approved by Dr. ${doctor.name}\n\n` +
            `To cancel: CANCEL ${appointmentId}`
        );

        twiml.message(`✅ Appointment #${appointmentId} approved.`);

    } catch (err) {
        console.error('❌ APPROVE ERROR:', err);
        twiml.message('❌ Error approving appointment.');
    }
}

/**
 * REJECT APPOINTMENT
 */
async function rejectAppointment(doctor, appointmentId, twiml) {
    try {
        const rows = await sql`
            SELECT a.*, c.whatsapp AS customer_phone
            FROM appointments a
            JOIN customers c ON a.customer_id = c.id
            WHERE a.id = ${appointmentId}
            AND a.doctor_id = ${doctor.id}
            AND a.status = 'pending'
            LIMIT 1
        `;

        if (rows.length === 0) {
            twiml.message('❌ Appointment not found or already processed.');
            return;
        }

        const appt = rows[0];

        await sql`
            UPDATE appointments
            SET status = 'rejected', updated_at = NOW()
            WHERE id = ${appointmentId}
        `;

        await sendWhatsAppMessage(
            appt.customer_phone,
            `❌ *Appointment Rejected*\n\n` +
            `📋 Booking #${appointmentId}\n` +
            `📅 ${appt.appointment_date}\n` +
            `⏰ ${appt.appointment_time}\n\n` +
            `Doctor unavailable. Please rebook.`
        );

        twiml.message(`❌ Appointment #${appointmentId} rejected.`);

    } catch (err) {
        console.error('❌ REJECT ERROR:', err);
        twiml.message('❌ Error rejecting appointment.');
    }
}

/**
 * CANCEL APPOINTMENT (Doctor)
 */
async function cancelAppointment(doctor, appointmentId, twiml) {
    try {
        const rows = await sql`
            SELECT a.*, c.whatsapp AS customer_phone
            FROM appointments a
            JOIN customers c ON a.customer_id = c.id
            WHERE a.id = ${appointmentId}
            AND a.doctor_id = ${doctor.id}
            AND a.status IN ('pending','confirmed')
            LIMIT 1
        `;

        if (rows.length === 0) {
            twiml.message('❌ Appointment not found.');
            return;
        }

        const appt = rows[0];

        await sql`
            UPDATE appointments
            SET status = 'cancelled', updated_at = NOW()
            WHERE id = ${appointmentId}
        `;

        await sendWhatsAppMessage(
            appt.customer_phone,
            `❌ *Appointment Cancelled by Doctor*\n\n` +
            `📋 Booking #${appointmentId}\n` +
            `📅 ${appt.appointment_date}\n` +
            `⏰ ${appt.appointment_time}`
        );

        twiml.message(`❌ Appointment #${appointmentId} cancelled.`);

    } catch (err) {
        console.error('❌ CANCEL ERROR:', err);
        twiml.message('❌ Error cancelling appointment.');
    }
}

/**
 * AUTO APPROVAL TOGGLE
 */
async function toggleAutoApproval(clinicId, enabled, twiml) {
    await sql`
        UPDATE clinics
        SET auto_approve = ${enabled}, updated_at = NOW()
        WHERE id = ${clinicId}
    `;
    twiml.message(`⚙️ Auto-Approval ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

async function checkAutoStatus(clinicId, twiml) {
    const rows = await sql`
        SELECT auto_approve FROM clinics WHERE id = ${clinicId}
    `;
    twiml.message(`⚙️ Auto-Approval is ${rows[0].auto_approve ? 'ON' : 'OFF'}`);
}

/**
 * HELP
 */
function showDoctorHelp(twiml) {
    twiml.message(
        `👨‍⚕️ *Doctor Commands*\n\n` +
        `APPROVE #id\n` +
        `REJECT #id\n` +
        `CANCEL #id\n\n` +
        `AUTO ON | AUTO OFF | AUTO STATUS\n` +
        `HELP`
    );
}

module.exports = {
    handleDoctorCommands
};

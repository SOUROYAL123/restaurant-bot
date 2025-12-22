// handlers/doctorCommands.js

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { sendWhatsAppMessage } = require('../utils/twilioClient');

async function handleDoctorCommands(userPhone, clinicId, message, twiml) {

    console.log('📥 DOCTOR MSG:', { userPhone, clinicId, message });

    const normalized = message.trim().toUpperCase();

    // 🔐 Verify doctor
    const doctors = await sql`
        SELECT id FROM doctors
        WHERE whatsapp = ${userPhone}
        AND clinic_id = ${clinicId}
        AND status = 'active'
        LIMIT 1
    `;

    if (doctors.length === 0) {
        console.log('⚠️ Ignored: not a doctor');
        return false;
    }

    /* =====================
       AUTO SETTINGS
    ====================== */

    if (normalized === 'AUTO APPROVE ON') {
        await sql`UPDATE clinics SET auto_approve = true WHERE id = ${clinicId}`;
        twiml.message('✅ Auto-Approve ENABLED');
        return true;
    }

    if (normalized === 'AUTO APPROVE OFF') {
        await sql`UPDATE clinics SET auto_approve = false WHERE id = ${clinicId}`;
        twiml.message('❌ Auto-Approve DISABLED');
        return true;
    }

    if (normalized === 'AUTO REJECT ON') {
        await sql`UPDATE clinics SET auto_reject = true WHERE id = ${clinicId}`;
        twiml.message('⚠️ Auto-Reject ENABLED');
        return true;
    }

    if (normalized === 'AUTO REJECT OFF') {
        await sql`UPDATE clinics SET auto_reject = false WHERE id = ${clinicId}`;
        twiml.message('✅ Auto-Reject DISABLED');
        return true;
    }

    if (normalized === 'AUTO STATUS') {
        const [c] = await sql`
            SELECT auto_approve, auto_reject, auto_reject_after_hours
            FROM clinics WHERE id = ${clinicId}
        `;
        twiml.message(
            `⚙️ Automation Status\n\n` +
            `Auto-Approve: ${c.auto_approve ? 'ON' : 'OFF'}\n` +
            `Auto-Reject: ${c.auto_reject ? `ON (${c.auto_reject_after_hours}h)` : 'OFF'}`
        );
        return true;
    }

    /* =====================
       APPROVE / REJECT
    ====================== */

    if (normalized.startsWith('APPROVE')) {
        const id = extractId(normalized);
        if (!id) return twiml.message('❌ Use: APPROVE #id');
        await approveAppointment(clinicId, id, twiml);
        return true;
    }

    if (normalized.startsWith('REJECT')) {
        const id = extractId(normalized);
        if (!id) return twiml.message('❌ Use: REJECT #id');
        await rejectAppointment(clinicId, id, twiml);
        return true;
    }

    if (normalized === 'HELP') {
        twiml.message(
            `👨‍⚕️ Doctor Commands\n\n` +
            `APPROVE #id\nREJECT #id\n\n` +
            `AUTO APPROVE ON|OFF\nAUTO REJECT ON|OFF\nAUTO STATUS`
        );
        return true;
    }

    return false;
}

function extractId(text) {
    const m = text.match(/#?(\d+)/);
    return m ? m[1] : null;
}

/* =====================
   APPROVE
====================== */
async function approveAppointment(clinicId, appointmentId, twiml) {

    const rows = await sql`
        SELECT a.id, a.appointment_date, a.appointment_time, c.whatsapp
        FROM appointments a
        JOIN customers c ON c.id = a.customer_id
        WHERE a.id = ${appointmentId}
        AND a.clinic_id = ${clinicId}
        AND a.status = 'pending'
        LIMIT 1
    `;

    if (!rows.length) {
        twiml.message('⚠️ Appointment already processed or not found.');
        return;
    }

    const appt = rows[0];

    await sql`
        UPDATE appointments
        SET status = 'confirmed'
        WHERE id = ${appointmentId}
    `;

    await sendWhatsAppMessage(
        appt.whatsapp,
        `✅ Appointment Confirmed\n\nBooking #${appointmentId}\n${appt.appointment_date} at ${appt.appointment_time}`
    );

    twiml.message(`✅ Appointment #${appointmentId} approved.`);
}

/* =====================
   REJECT
====================== */
async function rejectAppointment(clinicId, appointmentId, twiml) {

    const rows = await sql`
        SELECT a.id, a.appointment_date, a.appointment_time, c.whatsapp
        FROM appointments a
        JOIN customers c ON c.id = a.customer_id
        WHERE a.id = ${appointmentId}
        AND a.clinic_id = ${clinicId}
        AND a.status = 'pending'
        LIMIT 1
    `;

    if (!rows.length) {
        twiml.message('⚠️ Appointment already processed or not found.');
        return;
    }

    const appt = rows[0];

    await sql`
        UPDATE appointments
        SET status = 'rejected'
        WHERE id = ${appointmentId}
    `;

    await sendWhatsAppMessage(
        appt.whatsapp,
        `❌ Appointment Rejected\n\nBooking #${appointmentId}\nPlease book another slot.`
    );

    twiml.message(`❌ Appointment #${appointmentId} rejected.`);
}

module.exports = { handleDoctorCommands };

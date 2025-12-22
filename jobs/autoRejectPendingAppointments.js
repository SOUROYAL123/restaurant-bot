const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { sendWhatsAppMessage } = require('../utils/twilioClient');

async function autoRejectPendingAppointments() {

    const rows = await sql`
        SELECT a.id, c.whatsapp
        FROM appointments a
        JOIN customers c ON c.id = a.customer_id
        JOIN clinics cl ON cl.id = a.clinic_id
        WHERE a.status = 'pending'
        AND cl.auto_reject = true
        AND a.created_at < NOW() - (cl.auto_reject_after_hours || 24) * INTERVAL '1 hour'
    `;

    for (const appt of rows) {
        await sql`
            UPDATE appointments SET status = 'rejected'
            WHERE id = ${appt.id}
        `;

        await sendWhatsAppMessage(
            appt.whatsapp,
            `❌ Appointment expired\n\nThe doctor did not respond in time. Please rebook.`
        );
    }

    console.log(`⏳ Auto-rejected ${rows.length} appointments`);
}

module.exports = autoRejectPendingAppointments;

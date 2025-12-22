// handlers/appointmentBooking.js

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { sendWhatsAppMessage } = require('../utils/twilioClient');

/**
 * FINALIZE APPOINTMENT BOOKING
 * - Supports AUTO-APPROVE
 * - Supports MANUAL APPROVAL
 * - Safe with DB triggers
 */
async function finalizeAppointment({
    clinicId,
    customerId,
    patientPhone,
    appointmentDate,
    appointmentTime
}) {
    try {
        /* =========================
           1️⃣ Fetch clinic settings
        ========================== */
        const [clinic] = await sql`
            SELECT 
                name,
                doctor_whatsapp,
                auto_approve
            FROM clinics
            WHERE id = ${clinicId}
            LIMIT 1
        `;

        if (!clinic) {
            throw new Error('Clinic not found');
        }

        /* =========================
           2️⃣ Decide appointment status
        ========================== */
        const status = clinic.auto_approve ? 'confirmed' : 'pending';

        /* =========================
           3️⃣ Create appointment
        ========================== */
        const [appointment] = await sql`
            INSERT INTO appointments (
                clinic_id,
                customer_id,
                appointment_date,
                appointment_time,
                status,
                created_at
            )
            VALUES (
                ${clinicId},
                ${customerId},
                ${appointmentDate},
                ${appointmentTime},
                ${status},
                NOW()
            )
            RETURNING id
        `;

        const appointmentId = appointment.id;

        console.log(`✅ Appointment created: #${appointmentId} (${status})`);

        /* =========================
           4️⃣ Notify patient
        ========================== */

        if (status === 'confirmed') {
            // ✅ AUTO-APPROVED
            await sendWhatsAppMessage(
                patientPhone,
                `✅ *Appointment Confirmed*\n\n` +
                `🏥 Clinic: ${clinic.name}\n` +
                `📋 Booking ID: #${appointmentId}\n` +
                `📅 Date: ${appointmentDate}\n` +
                `⏰ Time: ${appointmentTime}\n\n` +
                `Your appointment has been automatically approved by the doctor.`
            );
        } else {
            // ⏳ WAITING FOR DOCTOR
            await sendWhatsAppMessage(
                patientPhone,
                `⏳ *Awaiting Doctor Confirmation*\n\n` +
                `🏥 Clinic: ${clinic.name}\n` +
                `📋 Booking ID: #${appointmentId}\n\n` +
                `Your request has been sent to the doctor.\n` +
                `You’ll receive a WhatsApp update once it’s approved or rejected.`
            );
        }

        /* =========================
           5️⃣ Notify doctor (only if pending)
        ========================== */
        if (status === 'pending') {
            await sendWhatsAppMessage(
                clinic.doctor_whatsapp,
                `📢 *New Appointment Request*\n\n` +
                `🏥 Clinic: ${clinic.name}\n` +
                `📋 Booking ID: #${appointmentId}\n` +
                `📅 Date: ${appointmentDate}\n` +
                `⏰ Time: ${appointmentTime}\n\n` +
                `Reply with:\n` +
                `APPROVE #${appointmentId}\n` +
                `REJECT #${appointmentId}`
            );
        }

        return {
            appointmentId,
            status
        };

    } catch (error) {
        console.error('❌ Booking error:', error);
        throw error;
    }
}

module.exports = {
    finalizeAppointment
};

// handlers/appointmentBooking.js

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { sendWhatsAppMessage } = require('../utils/twilioClient');

/**
 * MAIN BOOKING HANDLER
 * This is what bot.js EXPECTS
 */
async function handleBooking(session, message, twiml) {
    try {
        const stage = session.stage || 'main_menu';

        console.log('📍 Booking stage:', stage);

        switch (stage) {

            case 'main_menu':
                if (message === '1') {
                    session.stage = 'booking_name';
                    twiml.message('Please enter patient name:');
                }
                return;

            case 'booking_name':
                session.patientName = message;
                session.stage = 'booking_date';
                twiml.message('Enter appointment date (YYYY-MM-DD):');
                return;

            case 'booking_date':
                session.appointmentDate = message;
                session.stage = 'booking_time';
                twiml.message('Enter appointment time (HH:MM):');
                return;

            case 'booking_time':
                session.appointmentTime = message;
                session.stage = 'booking_confirm';
                twiml.message(
                    `Confirm appointment?\n\n` +
                    `Name: ${session.patientName}\n` +
                    `Date: ${session.appointmentDate}\n` +
                    `Time: ${session.appointmentTime}\n\n` +
                    `Reply YES to confirm or NO to cancel`
                );
                return;

            case 'booking_confirm':
                if (message.toUpperCase() === 'YES') {
                    await finalizeAppointment(session);
                    twiml.message('✅ Appointment booked. You will receive updates shortly.');
                    session.stage = 'main_menu';
                } else {
                    twiml.message('❌ Booking cancelled.');
                    session.stage = 'main_menu';
                }
                return;

            default:
                session.stage = 'main_menu';
                twiml.message('Welcome! Reply 1 to book appointment.');
        }

    } catch (err) {
        console.error('❌ handleBooking error:', err);
        twiml.message('❌ Something went wrong. Please try again.');
    }
}

/**
 * FINALIZE APPOINTMENT
 */
async function finalizeAppointment(session) {

    const {
        clinicId,
        customerId,
        patientPhone,
        appointmentDate,
        appointmentTime
    } = session;

    const [clinic] = await sql`
        SELECT auto_approve, doctor_whatsapp, name
        FROM clinics
        WHERE id = ${clinicId}
        LIMIT 1
    `;

    const status = clinic.auto_approve ? 'confirmed' : 'pending';

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

    // Patient notification
    await sendWhatsAppMessage(
        patientPhone,
        status === 'confirmed'
            ? `✅ Appointment Confirmed\nBooking #${appointmentId}`
            : `⏳ Awaiting doctor confirmation\nBooking #${appointmentId}`
    );

    // Doctor notification only if pending
    if (status === 'pending') {
        await sendWhatsAppMessage(
            clinic.doctor_whatsapp,
            `New appointment request\nBooking #${appointmentId}\nReply APPROVE #${appointmentId} or REJECT #${appointmentId}`
        );
    }
}

module.exports = {
    handleBooking   // 🔥 THIS FIXES EVERYTHING
};

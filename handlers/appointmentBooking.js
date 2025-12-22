// handlers/appointmentBooking.js

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

const SessionManager = require('../utils/sessionManager');
const { sendWhatsAppMessage } = require('../utils/twilioClient');

async function handleBooking(userPhone, clinicId, session, message, twiml) {
  const step = session.current_step;
  const text = message.trim();

  switch (step) {

    // ─────────────────────────────
    // START
    // ─────────────────────────────
    case 'booking_start': {
      twiml.message('👤 What is your full name?');
      await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_name',
        temp_data: {}
      });
      break;
    }

    // ─────────────────────────────
    // NAME
    // ─────────────────────────────
    case 'booking_name': {
      if (text.length < 2) {
        twiml.message('❌ Please enter a valid name.');
        return;
      }

      twiml.message(
        `📅 Enter appointment date\n\nFormat: DD-MM-YYYY\nExample: 25-12-2025`
      );

      await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_date',
        temp_data: { name: text }
      });
      break;
    }

    // ─────────────────────────────
    // DATE
    // ─────────────────────────────
    case 'booking_date': {
      const match = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (!match) {
        twiml.message('❌ Invalid date format. Use DD-MM-YYYY');
        return;
      }

      const [_, dd, mm, yyyy] = match;
      const dateISO = `${yyyy}-${mm}-${dd}`;

      twiml.message(
        `⏰ Enter preferred time\nExample: 10:30 AM`
      );

      await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_time',
        temp_data: { ...session.temp_data, appointment_date: dateISO }
      });
      break;
    }

    // ─────────────────────────────
    // TIME + CREATE APPOINTMENT
    // ─────────────────────────────
    case 'booking_time': {
      const { name, appointment_date } = session.temp_data;
      const appointment_time = text;

      // Fetch clinic config
      const clinicRes = await sql`
        SELECT name, auto_approve, doctor_whatsapp
        FROM clinics
        WHERE id = ${clinicId}
        LIMIT 1
      `;

      if (clinicRes.length === 0) {
        twiml.message('❌ Clinic configuration error.');
        return;
      }

      const clinic = clinicRes[0];
      const status = clinic.auto_approve ? 'confirmed' : 'pending';

      // Insert appointment
      const result = await sql`
        INSERT INTO appointments (
          clinic_id,
          patient_name,
          patient_phone,
          appointment_date,
          appointment_time,
          appointment_slot,
          status,
          created_at
        )
        VALUES (
          ${clinicId},
          ${name},
          ${userPhone},
          ${appointment_date},
          ${appointment_time},
          ${appointment_time},
          ${status},
          NOW()
        )
        RETURNING id
      `;

      const appointmentId = result[0].id;

      // ─────────────────────────────
      // DOCTOR APPROVAL FLOW
      // ─────────────────────────────
      if (!clinic.auto_approve && clinic.doctor_whatsapp) {
        const doctorMessage =
          `🔔 *New Appointment Request*\n\n` +
          `📋 ID: #${appointmentId}\n` +
          `👤 Patient: ${name}\n` +
          `📞 Phone: ${userPhone.replace('whatsapp:', '')}\n` +
          `📅 Date: ${appointment_date}\n` +
          `⏰ Time: ${appointment_time}\n\n` +
          `Reply:\n` +
          `APPROVE #${appointmentId}\n` +
          `REJECT #${appointmentId}`;

        await sendWhatsAppMessage(clinic.doctor_whatsapp, doctorMessage);
      }

      // ─────────────────────────────
      // PATIENT RESPONSE
      // ─────────────────────────────
      if (clinic.auto_approve) {
        twiml.message(
          `✅ *Appointment Confirmed!*\n\n` +
          `📋 Booking #${appointmentId}\n` +
          `👤 ${name}\n` +
          `📅 ${appointment_date}\n` +
          `⏰ ${appointment_time}\n\n` +
          `Thank you!\n\nType *hi* to book again.`
        );
      } else {
        twiml.message(
          `⏳ *Appointment Request Submitted*\n\n` +
          `📋 Booking #${appointmentId}\n` +
          `📅 ${appointment_date}\n` +
          `⏰ ${appointment_time}\n\n` +
          `Waiting for doctor approval.\n\n` +
          `You will be notified shortly.`
        );
      }

      await SessionManager.clearSession(userPhone, clinicId);
      break;
    }

    // ─────────────────────────────
    // FALLBACK
    // ─────────────────────────────
    default: {
      twiml.message('Type *hi* to start booking.');
      await SessionManager.clearSession(userPhone, clinicId);
    }
  }
}

module.exports = { handleBooking };

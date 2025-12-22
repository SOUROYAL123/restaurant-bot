// handlers/appointmentBooking.js

const pool = require('../db');
const SessionManager = require('../utils/sessionManager');

/**
 * Main booking handler
 */
async function handleBooking(userPhone, clinicId, session, message, twiml) {
  const step = session.current_step;
  const text = message.trim();

  switch (step) {

    // -----------------------------
    // START BOOKING
    // -----------------------------
    case 'booking_start': {
      twiml.message('👤 What is your full name?');

      await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_name'
      });
      break;
    }

    // -----------------------------
    // NAME
    // -----------------------------
    case 'booking_name': {
      if (text.length < 2) {
        twiml.message('❌ Please enter a valid name.');
        return;
      }

      await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_date',
        temp_data: { name: text }
      });

      twiml.message('📅 Enter appointment date (DD-MM-YYYY)');
      break;
    }

    // -----------------------------
    // DATE
    // -----------------------------
    case 'booking_date': {
      const match = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (!match) {
        twiml.message('❌ Invalid format. Use DD-MM-YYYY');
        return;
      }

      await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_time',
        temp_data: { ...session.temp_data, date: text }
      });

      twiml.message('⏰ Enter preferred time (e.g. 5:00PM)');
      break;
    }

    // -----------------------------
    // TIME + SAVE APPOINTMENT
    // -----------------------------
    case 'booking_time': {
      const { name, date } = session.temp_data;

      const result = await pool.query(
        `INSERT INTO appointments
         (clinic_id, patient_name, patient_phone, appointment_date, appointment_time, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
         RETURNING id`,
        [clinicId, name, userPhone, date, text]
      );

      const appointmentId = result.rows[0].id;

      twiml.message(
        `⏳ Appointment request submitted\n\n` +
        `📋 Booking ID: #${appointmentId}\n\n` +
        `Waiting for doctor approval.`
      );

      await SessionManager.clearSession(userPhone, clinicId);
      break;
    }

    // -----------------------------
    // FALLBACK
    // -----------------------------
    default: {
      twiml.message('Type *hi* to start booking.');
      await SessionManager.clearSession(userPhone, clinicId);
    }
  }
}

module.exports = { handleBooking };

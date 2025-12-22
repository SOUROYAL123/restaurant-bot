// handlers/doctorCommands.js
const pool = require('../db');

async function handleDoctorCommands(userPhone, clinicId, message, twiml) {
  const text = message.trim().toUpperCase();

  // Only APPROVE / REJECT commands
  if (!text.startsWith('APPROVE') && !text.startsWith('REJECT')) {
    return false;
  }

  // Verify doctor number
  const clinicRes = await pool.query(
    `SELECT doctor_whatsapp FROM clinics WHERE id = $1`,
    [clinicId]
  );

  if (clinicRes.rows.length === 0) return false;

  const doctorPhone = clinicRes.rows[0].doctor_whatsapp;

  if (userPhone !== doctorPhone) {
    console.log('⚠️ Ignored: not a doctor');
    return false;
  }

  // Extract appointment ID
  const match = text.match(/#(\d+)/);
  if (!match) {
    twiml.message('❌ Invalid format. Use APPROVE #<id> or REJECT #<id>');
    return true;
  }

  const appointmentId = match[1];
  const newStatus = text.startsWith('APPROVE') ? 'confirmed' : 'rejected';

  // Update appointment
  const result = await pool.query(
    `UPDATE appointments
     SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING patient_phone, patient_name, appointment_date, appointment_time`,
    [newStatus, appointmentId]
  );

  if (result.rows.length === 0) {
    twiml.message(`❌ Appointment #${appointmentId} not found.`);
    return true;
  }

  const appt = result.rows[0];

  // Notify patient
  const patientMessage =
    newStatus === 'confirmed'
      ? `✅ *Appointment Approved*\n\n📋 #${appointmentId}\n📅 ${appt.appointment_date}\n⏰ ${appt.appointment_time}`
      : `❌ *Appointment Rejected*\n\n📋 #${appointmentId}\nPlease contact clinic.`;

  twiml.message(
    `✅ Appointment #${appointmentId} ${newStatus.toUpperCase()}`
  );

  // Send patient WhatsApp message
  const twilio = require('twilio');
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: appt.patient_phone,
    body: patientMessage
  });

  console.log(`✅ Doctor ${newStatus} appointment #${appointmentId}`);

  return true; // 🔴 THIS WAS CRITICAL
}

module.exports = { handleBooking };


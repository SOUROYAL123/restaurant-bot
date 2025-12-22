// handlers/doctorCommands.js
const pool = require('../db');
const twilio = require('twilio');

async function normalize(phone) {
  return phone.replace('whatsapp:', '').trim();
}

async function handleDoctorCommands(userPhone, clinicId, message, twiml) {
  const text = message.trim().toUpperCase();

  // Only doctor commands
  if (!text.startsWith('APPROVE') && !text.startsWith('REJECT')) {
    return false;
  }

  console.log('🩺 Doctor command detected:', text);

  // Get doctor number
  const clinicRes = await pool.query(
    `SELECT doctor_whatsapp FROM clinics WHERE id = $1`,
    [clinicId]
  );

  if (clinicRes.rows.length === 0) {
    console.log('❌ Clinic not found for doctor command');
    return false;
  }

  const doctorPhone = clinicRes.rows[0].doctor_whatsapp;

  if (normalize(userPhone) !== normalize(doctorPhone)) {
    console.log('⚠️ Ignored: sender is not doctor');
    return false;
  }

  // Extract appointment ID
  const match = text.match(/#(\d+)/);
  if (!match) {
    twiml.message('❌ Invalid format.\nUse: APPROVE #<id> or REJECT #<id>');
    return true;
  }

  const appointmentId = Number(match[1]);
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

  // Reply to doctor (THIS WAS MISSING)
  twiml.message(
    `✅ Appointment #${appointmentId} ${newStatus.toUpperCase()}`
  );

  // Notify patient
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  const patientMessage =
    newStatus === 'confirmed'
      ? `✅ *Appointment Approved*\n\n📋 #${appointmentId}\n📅 ${appt.appointment_date}\n⏰ ${appt.appointment_time}`
      : `❌ *Appointment Rejected*\n\n📋 #${appointmentId}\nPlease contact clinic.`;

  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: appt.patient_phone,
    body: patientMessage
  });

  console.log(`✅ Doctor ${newStatus} appointment #${appointmentId}`);

  return true; // 🔴 ABSOLUTELY REQUIRED
}

module.exports = { handleDoctorCommands };

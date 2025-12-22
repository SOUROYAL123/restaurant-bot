// handlers/doctorCommands.js
const pool = require('../db');
const twilio = require('twilio');

function normalize(phone) {
  return phone.replace('whatsapp:', '').replace(/\s+/g, '');
}

async function handleDoctorCommands(userPhone, clinicId, message, twiml) {
  const text = message.trim().toUpperCase();

  if (!text.startsWith('APPROVE') && !text.startsWith('REJECT')) {
    return false;
  }

  console.log('🩺 Doctor command detected:', text);

  const clinicRes = await pool.query(
    'SELECT doctor_whatsapp FROM clinics WHERE id = $1',
    [clinicId]
  );

  if (clinicRes.rows.length === 0) return false;

  const doctorPhone = clinicRes.rows[0].doctor_whatsapp;

  // ✅ FIXED comparison
  if (normalize(userPhone) !== normalize(doctorPhone)) {
    console.log('⚠️ Ignored: sender is not doctor');
    return false;
  }

  const match = text.match(/#(\d+)/);
  if (!match) {
    twiml.message('❌ Use: APPROVE #<id> or REJECT #<id>');
    return true;
  }

  const appointmentId = Number(match[1]);
  const newStatus = text.startsWith('APPROVE') ? 'confirmed' : 'rejected';

  const result = await pool.query(
    `UPDATE appointments
     SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING patient_phone, appointment_date, appointment_time`,
    [newStatus, appointmentId]
  );

  if (result.rows.length === 0) {
    twiml.message(`❌ Appointment #${appointmentId} not found`);
    return true;
  }

  twiml.message(`✅ Appointment #${appointmentId} ${newStatus.toUpperCase()}`);

  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  const patientMsg =
    newStatus === 'confirmed'
      ? `✅ Appointment Approved\n\n📅 ${result.rows[0].appointment_date}\n⏰ ${result.rows[0].appointment_time}`
      : `❌ Appointment Rejected\n\nPlease contact clinic.`;

  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: result.rows[0].patient_phone,
    body: patientMsg
  });

  console.log(`✅ Doctor ${newStatus} appointment #${appointmentId}`);

  return true; // 🚨 REQUIRED
}

module.exports = { handleDoctorCommands };

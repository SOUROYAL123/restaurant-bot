const pool = require('../db');

async function notifyDoctor(twilioClient, clinicId, appointmentDetails) {
  const clinic = await pool.query(
    'SELECT doctor_whatsapp, name FROM clinics WHERE id = $1',
    [clinicId]
  );
  
  if (clinic.rows.length === 0) return;
  
  const { doctor_whatsapp, name } = clinic.rows[0];
  const message = `
🏥 *New Appointment - ${name}*

👤 Patient: ${appointmentDetails.patientName}
📞 Phone: ${appointmentDetails.patientPhone}
📅 Date: ${appointmentDetails.date}
⏰ Time: ${appointmentDetails.slot}

ID: #${appointmentDetails.appointmentId}
  `.trim();
  
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: doctor_whatsapp,
    body: message
  });
}

module.exports = { notifyDoctor };
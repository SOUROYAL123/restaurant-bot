const pool = require('../db');

async function notifyDoctor(twilioClient, clinicId, appointmentDetails) {
  try {
    const clinic = await pool.query(
      'SELECT doctor_whatsapp, name FROM clinics WHERE id = $1',
      [clinicId]
    );
    
    if (clinic.rows.length === 0) {
      console.error(`❌ Clinic ${clinicId} not found`);
      return;
    }
    
    const { doctor_whatsapp, name } = clinic.rows[0];
    
    const [year, month, day] = appointmentDetails.date.split('-');
    const formattedDate = `${day}-${month}-${year}`;
    
    const message = `✅ *New Confirmed Appointment*

📌 *ID:* #${appointmentDetails.appointmentId}
👤 *Patient:* ${appointmentDetails.patientName}
📞 *Phone:* ${appointmentDetails.patientPhone}
📅 *Date:* ${formattedDate}
⏰ *Time:* ${appointmentDetails.slot}

Status: *CONFIRMED*

To cancel: Reply "CANCEL ${appointmentDetails.appointmentId}"`;
    
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: doctor_whatsapp,
      body: message
    });
    
    console.log(`✅ Doctor notification sent to ${doctor_whatsapp}`);
    
  } catch (error) {
    console.error('❌ Error sending doctor notification:', error.message);
  }
}

module.exports = { notifyDoctor };

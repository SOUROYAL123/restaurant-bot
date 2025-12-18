const db = require('../config/database');
const twilio = require('twilio');

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);
const twilioWhatsAppNumber = process.env.WABA_NUMBER;

/**
 * Notify doctor about new appointment
 */
async function notifyDoctor(clinicId, appointment) {
    try {
        // Get doctor info for this clinic
        const result = await db.query(`
            SELECT d.name, d.whatsapp, c.name as clinic_name
            FROM doctors d
            JOIN clinics c ON d.clinic_id = c.id
            WHERE c.id = $1 AND d.status = 'active'
            LIMIT 1
        `, [clinicId]);
        
        if (result.rows.length === 0) {
            console.log('⚠️ No active doctor found for clinic', clinicId);
            return;
        }
        
        const doctor = result.rows[0];
        
        // Format date
        const [year, month, day] = appointment.appointment_date.split('-');
        const formattedDate = `${day}-${month}-${year}`;
        
        // Format time
        const formattedTime = appointment.appointment_time.substring(0, 5);
        
        const message = `🔔 *New Appointment Booked*

📌 *Booking ID:* #${appointment.id}
🏥 *Clinic:* ${doctor.clinic_name}

👤 *Patient:* ${appointment.customer_name}
📞 *Phone:* ${appointment.customer_phone}
📅 *Date:* ${formattedDate}
⏰ *Time:* ${formattedTime}
${appointment.service ? `💊 *Service:* ${appointment.service}\n` : ''}
✅ *Status:* ${appointment.status.toUpperCase()}

---
*Quick Actions:*
• View all: https://your-dashboard.com
• Cancel: Reply "CANCEL ${appointment.id}"`;

        await twilioClient.messages.create({
            from: twilioWhatsAppNumber,
            to: doctor.whatsapp,
            body: message
        });
        
        console.log(`✅ Doctor notification sent to ${doctor.name} (${doctor.whatsapp})`);
        
    } catch (error) {
        console.error('❌ Doctor notification failed:', error.message);
        // Don't throw - booking should succeed even if notification fails
    }
}

/**
 * Notify doctor about appointment cancellation
 */
async function notifyDoctorCancellation(clinicId, appointment) {
    try {
        const result = await db.query(`
            SELECT d.name, d.whatsapp, c.name as clinic_name
            FROM doctors d
            JOIN clinics c ON d.clinic_id = c.id
            WHERE c.id = $1 AND d.status = 'active'
            LIMIT 1
        `, [clinicId]);
        
        if (result.rows.length === 0) return;
        
        const doctor = result.rows[0];
        
        const [year, month, day] = appointment.appointment_date.split('-');
        const formattedDate = `${day}-${month}-${year}`;
        const formattedTime = appointment.appointment_time.substring(0, 5);
        
        const message = `❌ *Appointment Cancelled*

📌 *Booking ID:* #${appointment.id}
👤 *Patient:* ${appointment.customer_name}
📞 *Phone:* ${appointment.customer_phone}
📅 *Date:* ${formattedDate}
⏰ *Time:* ${formattedTime}

Slot is now available for rebooking.`;

        await twilioClient.messages.create({
            from: twilioWhatsAppNumber,
            to: doctor.whatsapp,
            body: message
        });
        
        console.log(`✅ Cancellation notification sent to ${doctor.name}`);
        
    } catch (error) {
        console.error('❌ Cancellation notification failed:', error.message);
    }
}

module.exports = {
    notifyDoctor,
    notifyDoctorCancellation
};

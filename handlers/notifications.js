const { neon } = require('@neondatabase/serverless');
const { sendWhatsAppMessage } = require('../utils/twilioClient');

const sql = neon(process.env.DATABASE_URL);

async function notifyDoctor(appointmentId) {
    try {
        const appointments = await sql`
            SELECT 
                a.*,
                c.name as clinic_name,
                c.doctor_name,
                c.doctor_whatsapp,
                c.auto_approve,
                c.auto_approve_after_hours
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE a.id = ${appointmentId}
        `;
        
        if (appointments.length === 0) {
            console.error(`Appointment #${appointmentId} not found`);
            return false;
        }
        
        const appt = appointments[0];
        
        // Format date
        const date = new Date(appt.appointment_date).toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'long',
            year: 'numeric'
        });
        
        const autoApproveInfo = appt.auto_approve 
            ? `\n⚠️ Will auto-approve in ${appt.auto_approve_after_hours} hours if no response`
            : '';
        
        const message = `🔔 *New Appointment Request*\n\n` +
            `📋 ID: #${appt.id}\n` +
            `🏥 Clinic: ${appt.clinic_name}\n` +
            `👤 Patient: ${appt.patient_name}\n` +
            `📞 Phone: ${appt.patient_phone}\n` +
            `📅 Date: ${date}\n` +
            `🕒 Time: ${appt.appointment_time}\n` +
            `${appt.service ? `💊 Service: ${appt.service}\n` : ''}` +
            `\n━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `To approve: *APPROVE #${appt.id}*\n` +
            `To reject: *REJECT #${appt.id}*${autoApproveInfo}`;
        
        await sendWhatsAppMessage(appt.doctor_whatsapp, message);
        
        console.log(`✅ Doctor notification sent for appointment #${appointmentId}`);
        return true;
        
    } catch (error) {
        console.error('❌ Doctor notification error:', error.message);
        return false;
    }
}

module.exports = { notifyDoctor };

// handlers/appointmentViewing.js
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

/**
 * View customer's appointments
 */
async function viewAppointments(userPhone, clinicId, twiml) {
    try {
        // Get customer
        const customers = await sql`
            SELECT id FROM customers 
            WHERE whatsapp = ${userPhone} 
            AND clinic_id = ${clinicId}
            LIMIT 1
        `;

        if (customers.length === 0) {
            twiml.message('You have no appointments yet.\n\nReply 1 to book an appointment.');
            return;
        }

        const customerId = customers[0].id;

        // Get all appointments (pending and confirmed)
        const appointments = await sql`
            SELECT 
                a.*,
                d.name as doctor_name
            FROM appointments a
            LEFT JOIN doctors d ON a.doctor_id = d.id
            WHERE a.customer_id = ${customerId}
            AND a.status IN ('pending', 'confirmed')
            ORDER BY a.appointment_date, a.appointment_time
            LIMIT 10
        `;

        if (appointments.length === 0) {
            twiml.message('📅 You have no upcoming appointments.\n\nReply 1 to book an appointment.');
            return;
        }

        let message = '📅 *Your Appointments*\n\n';

        appointments.forEach((apt, index) => {
            const statusEmoji = apt.status === 'confirmed' ? '✅' : '⏳';
            const statusText = apt.status === 'confirmed' ? 'Confirmed' : 'Pending';
            
            message += `${index + 1}. ${statusEmoji} *${statusText}*\n`;
            message += `   📅 Date: ${apt.appointment_date}\n`;
            message += `   ⏰ Time: ${apt.appointment_time}\n`;
            
            if (apt.doctor_name) {
                message += `   👨‍⚕️ Doctor: ${apt.doctor_name}\n`;
            }
            
            if (apt.status === 'pending') {
                message += `   ℹ️ Awaiting doctor confirmation\n`;
            }
            
            message += '\n';
        });

        message += 'Reply 0 for main menu.';

        twiml.message(message);

    } catch (error) {
        console.error('Error viewing appointments:', error);
        twiml.message('❌ Error retrieving appointments. Please try again.');
    }
}

module.exports = {
    viewAppointments
};

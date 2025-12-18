require('dotenv').config();
const db = require('./config/database');
const twilio = require('twilio');

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);
const twilioWhatsAppNumber = process.env.WABA_NUMBER;

/**
 * Send appointment reminders for next day
 * Run this as a cron job every day at 6 PM
 */
async function sendReminders() {
    try {
        console.log('🔔 Starting reminder job...');
        
        // Get tomorrow's date
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowDate = tomorrow.toISOString().split('T')[0];
        
        // Get appointments for tomorrow that haven't been reminded
        const result = await db.query(`
            SELECT 
                a.id,
                a.customer_phone,
                a.customer_name,
                a.appointment_date,
                a.appointment_time,
                a.service,
                c.name as clinic_name,
                cu.preferred_language,
                d.name as doctor_name
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            LEFT JOIN customers cu ON a.customer_id = cu.id
            LEFT JOIN doctors d ON a.doctor_id = d.id
            WHERE a.appointment_date = $1
              AND a.status IN ('pending', 'confirmed')
              AND a.reminder_sent = false
            ORDER BY a.appointment_time
        `, [tomorrowDate]);
        
        console.log(`📊 Found ${result.rows.length} appointments for ${tomorrowDate}`);
        
        let sent = 0;
        let failed = 0;
        
        for (const appointment of result.rows) {
            try {
                const message = getReminderMessage(appointment);
                
                await twilioClient.messages.create({
                    from: twilioWhatsAppNumber,
                    to: `whatsapp:${appointment.customer_phone}`,
                    body: message
                });
                
                // Mark as reminded
                await db.query(
                    'UPDATE appointments SET reminder_sent = true WHERE id = $1',
                    [appointment.id]
                );
                
                sent++;
                console.log(`✅ Reminder sent to ${appointment.customer_name} (ID: ${appointment.id})`);
                
                // Rate limiting: Wait 1 second between messages
                await sleep(1000);
                
            } catch (error) {
                failed++;
                console.error(`❌ Failed to send reminder for appointment ${appointment.id}:`, error.message);
            }
        }
        
        console.log(`\n📈 Summary: ${sent} sent, ${failed} failed`);
        
        // Log reminder job execution
        await db.query(`
            INSERT INTO customer_interactions (
                customer_id, 
                clinic_id, 
                interaction_type, 
                message_body
            )
            SELECT 
                customer_id,
                clinic_id,
                'reminder_sent',
                'Reminder job completed: ' || $1 || ' sent, ' || $2 || ' failed'
            FROM appointments
            WHERE id = $3
            LIMIT 1
        `, [sent, failed, result.rows[0]?.id || 1]);
        
    } catch (error) {
        console.error('❌ Reminder job failed:', error);
        throw error;
    }
}

/**
 * Generate reminder message in user's language
 */
function getReminderMessage(appointment) {
    const { 
        customer_name, 
        appointment_date, 
        appointment_time, 
        clinic_name,
        service,
        doctor_name,
        preferred_language,
        id 
    } = appointment;
    
    // Format date
    const [year, month, day] = appointment_date.split('-');
    const formattedDate = `${day}-${month}-${year}`;
    
    // Format time (remove seconds)
    const formattedTime = appointment_time.substring(0, 5);
    
    const lang = preferred_language || 'en';
    
    const messages = {
        en: `🔔 *Appointment Reminder*

Hello ${customer_name}! 👋

Your appointment is *tomorrow*:

🏥 *Clinic:* ${clinic_name}
${doctor_name ? `👨‍⚕️ *Doctor:* ${doctor_name}\n` : ''}📅 *Date:* ${formattedDate}
⏰ *Time:* ${formattedTime}
${service ? `💊 *Service:* ${service}\n` : ''}
📌 *Booking ID:* #${id}

Please arrive 10 minutes early.

To cancel: Reply "CANCEL ${id}"
For help: Reply "HELP"`,

        hi: `🔔 *अपॉइंटमेंट रिमाइंडर*

नमस्ते ${customer_name}! 👋

आपकी अपॉइंटमेंट *कल* है:

🏥 *क्लिनिक:* ${clinic_name}
${doctor_name ? `👨‍⚕️ *डॉक्टर:* ${doctor_name}\n` : ''}📅 *तारीख:* ${formattedDate}
⏰ *समय:* ${formattedTime}
${service ? `💊 *सेवा:* ${service}\n` : ''}
📌 *बुकिंग ID:* #${id}

कृपया 10 मिनट पहले पहुंचें।

रद्द करने के लिए: "CANCEL ${id}" लिखें
मदद के लिए: "HELP" लिखें`,

        bn: `🔔 *অ্যাপয়েন্টমেন্ট রিমাইন্ডার*

হ্যালো ${customer_name}! 👋

আপনার অ্যাপয়েন্টমেন্ট *কাল*:

🏥 *ক্লিনিক:* ${clinic_name}
${doctor_name ? `👨‍⚕️ *ডাক্তার:* ${doctor_name}\n` : ''}📅 *তারিখ:* ${formattedDate}
⏰ *সময়:* ${formattedTime}
${service ? `💊 *সেবা:* ${service}\n` : ''}
📌 *বুকিং ID:* #${id}

অনুগ্রহ করে 10 মিনিট আগে পৌঁছান।

বাতিল করতে: "CANCEL ${id}" লিখুন
সাহায্যের জন্য: "HELP" লিখুন`
    };
    
    return messages[lang] || messages.en;
}

/**
 * Sleep helper for rate limiting
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Run if executed directly
if (require.main === module) {
    sendReminders()
        .then(() => {
            console.log('✅ Reminder job completed successfully');
            process.exit(0);
        })
        .catch(error => {
            console.error('❌ Reminder job failed:', error);
            process.exit(1);
        });
}

module.exports = { sendReminders };

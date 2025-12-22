// test-doctor-notification.js
require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const { sendWhatsAppMessage } = require('./utils/twilioClient');

const sql = neon(process.env.DATABASE_URL);

async function testDoctorNotification() {
    try {
        console.log('🔍 Testing Doctor Notification System\n');
        
        // 1. Check database configuration
        console.log('📊 Checking database...');
        const clinic = await sql`
            SELECT id, name, doctor_whatsapp, auto_approve 
            FROM clinics WHERE id = 1
        `;
        
        if (clinic.length === 0) {
            console.log('❌ No clinic found!');
            return;
        }
        
        console.log('✅ Clinic found:');
        console.log('   Name:', clinic[0].name);
        console.log('   Doctor WhatsApp:', clinic[0].doctor_whatsapp);
        console.log('   Auto-approve:', clinic[0].auto_approve);
        console.log('');
        
        // 2. Check if doctor exists
        const doctors = await sql`
            SELECT * FROM doctors 
            WHERE whatsapp = 'whatsapp:+919748006945'
        `;
        
        console.log('👨‍⚕️ Doctor in database:', doctors.length > 0 ? 'YES ✅' : 'NO ❌');
        if (doctors.length > 0) {
            console.log('   Name:', doctors[0].name);
            console.log('   Status:', doctors[0].status);
        }
        console.log('');
        
        // 3. Check environment variables
        console.log('⚙️ Environment Check:');
        console.log('   WABA_NUMBER:', process.env.WABA_NUMBER);
        console.log('   TWILIO_ACCOUNT_SID:', process.env.TWILIO_ACCOUNT_SID ? '✅ Set' : '❌ Missing');
        console.log('   TWILIO_AUTH_TOKEN:', process.env.TWILIO_AUTH_TOKEN ? '✅ Set' : '❌ Missing');
        console.log('');
        
        // 4. Send test message
        console.log('📤 Sending test notification to doctor...');
        const testMessage = `🧪 *Test Notification*

This is a test message from your clinic bot.

If you receive this, the notification system is working!

Reply "TEST OK" to confirm.`;
        
        const result = await sendWhatsAppMessage(
            clinic[0].doctor_whatsapp,
            testMessage
        );
        
        if (result) {
            console.log('✅ Message sent successfully!');
            console.log('');
            console.log('📱 Check doctor\'s WhatsApp: +919748006945');
        } else {
            console.log('❌ Message failed to send');
        }
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('Stack:', error.stack);
    }
}

testDoctorNotification();

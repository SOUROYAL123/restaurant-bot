// send-test-notification.js
require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

async function sendTest() {
    try {
        console.log('📤 Sending test message...');
        console.log('From:', process.env.WABA_NUMBER);
        console.log('To: whatsapp:+919748006945');
        console.log('');
        
        const message = await client.messages.create({
            from: process.env.WABA_NUMBER,
            to: 'whatsapp:+919748006945',
            body: `🧪 TEST MESSAGE

This is a test notification.

If you receive this, notifications are working!

Reply "OK" to confirm.`
        });
        
        console.log('✅ Message sent!');
        console.log('Message SID:', message.sid);
        console.log('Status:', message.status);
        console.log('');
        console.log('Check delivery status at:');
        console.log(`https://console.twilio.com/us1/monitor/logs/sms/${message.sid}`);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('');
        console.error('Common issues:');
        console.error('1. Number not verified in Twilio sandbox');
        console.error('2. Number hasn\'t joined WhatsApp sandbox');
        console.error('3. Invalid Twilio credentials');
    }
}

sendTest();

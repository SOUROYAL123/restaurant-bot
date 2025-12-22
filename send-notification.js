// send-notification.js
require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

async function sendNotification() {
    try {
        console.log('📤 Sending notification to doctor...');
        
        const message = await client.messages.create({
            from: process.env.WABA_NUMBER,
            to: 'whatsapp:+919748006945',
            body: `🔔 *New Appointment Request*

📋 ID: #17
👤 Patient: Gourav Roy
📅 Date: 23 Dec 2025
⏰ Time: 2:00 PM

Reply to manage:
APPROVE #17 - to confirm
REJECT #17 - to decline`
        });
        
        console.log('✅ Message sent!');
        console.log('Message SID:', message.sid);
        console.log('');
        console.log('Doctor should receive the message on WhatsApp now.');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

sendNotification();

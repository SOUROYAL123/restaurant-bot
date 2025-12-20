// utils/twilioClient.js
const twilio = require('twilio');

// Initialize Twilio client
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
    throw new Error('Missing Twilio credentials in environment variables');
}

const client = twilio(accountSid, authToken);

/**
 * Send WhatsApp message
 */
async function sendWhatsAppMessage(phoneNumber, message) {
    try {
        // Handle both formats: with or without whatsapp: prefix
        let toNumber = phoneNumber;
        
        if (!toNumber.startsWith('whatsapp:')) {
            toNumber = `whatsapp:+${phoneNumber.replace(/[^0-9]/g, '')}`;
        }
        
        await client.messages.create({
            from: process.env.WABA_NUMBER,
            to: toNumber,
            body: message
        });
        
        console.log(`✅ Message sent to ${phoneNumber}`);
        return true;
        
    } catch (error) {
        console.error(`❌ Error sending message to ${phoneNumber}:`, error.message);
        return false;
    }
}

module.exports = {
    client,
    sendWhatsAppMessage
};

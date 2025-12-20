// utils/twilioClient.js
const twilio = require('twilio');

// Initialize Twilio client
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
    throw new Error('Missing Twilio credentials in environment variables');
}

const client = twilio(accountSid, authToken);

module.exports = client;

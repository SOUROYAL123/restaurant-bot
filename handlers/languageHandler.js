// handlers/languageHandler.js
const SessionManager = require('../utils/sessionManager');

async function handle(userPhone, message, twiml, clinicId) {
  const text = message.trim().toLowerCase();

  // Greeting → language menu
  if (['hi', 'hello', 'start'].includes(text)) {
    twiml.message(
      `🏥 *Welcome to Appointment Booking*\n\n` +
      `Please select your language:\n\n` +
      `1️⃣ English\n2️⃣ বাংলা (Bengali)\n3️⃣ हिंदी (Hindi)`
    );
    return true;
  }

  // Language selection
  if (['1', '2', '3'].includes(text)) {
    const map = { '1': 'en', '2': 'bn', '3': 'hi' };
    const language = map[text];

    await SessionManager.setUserLanguage(userPhone, clinicId, language);

    twiml.message(
      `✅ Language selected.\n\n` +
      `Let’s book your appointment.\n\n` +
      `👤 What is your full name?`
    );

    await SessionManager.updateSession(userPhone, clinicId, {
      current_step: 'booking_name'
    });

    return true;
  }

  return false;
}

module.exports = { handle };

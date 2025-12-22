const { setUserLanguage } = require('../utils/sessionManager');

async function handle(userPhone, message, twiml) {
  const text = message.toLowerCase();

  if (['hi', 'hello', 'start'].includes(text)) {
    twiml.message(
      `🏥 Welcome to Appointment Booking\n\n1️⃣ English\n2️⃣ বাংলা\n3️⃣ हिंदी`
    );
    return true;
  }

  if (['1', '2', '3'].includes(text)) {
    const map = { '1': 'en', '2': 'bn', '3': 'hi' };
    await setUserLanguage(userPhone, map[text]);
    twiml.message('✅ Language selected. Please continue.');
    return true;
  }

  return false;
}

module.exports = { handle };

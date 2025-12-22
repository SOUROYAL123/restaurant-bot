const SessionManager = require('../utils/sessionManager');

async function handleBooking(userPhone, clinicId, session, message, twiml) {
  switch (session.current_step) {

    case 'booking_start':
      twiml.message('👤 What is your name?');
      await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_name'
      });
      break;

    case 'booking_name':
      twiml.message('📅 Enter appointment date (DD-MM-YYYY)');
      await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_date',
        temp_data: { name: message }
      });
      break;

    case 'booking_date':
      twiml.message('⏰ Enter preferred time');
      await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_time',
        temp_data: { ...session.temp_data, date: message }
      });
      break;

    case 'booking_time':
      twiml.message('✅ Appointment request submitted.');
      await SessionManager.clearSession(userPhone, clinicId);
      break;

    default:
      twiml.message('Type *hi* to start booking.');
      await SessionManager.clearSession(userPhone, clinicId);
  }
}

module.exports = { handleBooking };

// handlers/appointmentBooking.js

async function handleBooking({
  userPhone,
  clinic,
  message,
  stage,
  sendMessage
}) {
  try {
    if (typeof sendMessage !== 'function') {
      throw new Error('sendMessage not injected');
    }

    // ENTRY POINT
    if (stage === 'booking_start') {
      await sendMessage(
        userPhone,
        '📅 Book Appointment\n\n1️⃣ Today\n2️⃣ Tomorrow'
      );
      return;
    }

    // DATE SELECTED
    if (stage === 'select_date') {
      await sendMessage(
        userPhone,
        '⏰ Select time:\n1️⃣ Morning\n2️⃣ Evening'
      );
      return;
    }

    // FINAL CONFIRMATION
    await sendMessage(
      userPhone,
      '✅ Appointment request submitted. Doctor will confirm shortly.'
    );

  } catch (err) {
    console.error('❌ AppointmentBooking handler error:', err.message);

    if (typeof sendMessage === 'function') {
      await sendMessage(
        userPhone,
        '❌ Booking failed. Please try again.'
      );
    }
  }
}

module.exports = { handleBooking };

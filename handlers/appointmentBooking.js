// handlers/AppointmentBooking.js

async function handleBooking({
  userPhone,
  clinic,
  message,
  stage,
  sendMessage
}) {
  try {
    // Step 1: entry from main menu
    if (stage === 'main_menu') {
      await sendMessage(
        userPhone,
        '📅 Book Appointment\n\n1️⃣ Today\n2️⃣ Tomorrow'
      );
      return;
    }

    // Step 2: example follow-up
    if (stage === 'select_date') {
      await sendMessage(
        userPhone,
        '⏰ Please select time:\n1️⃣ Morning\n2️⃣ Evening'
      );
      return;
    }

    // Final confirmation (example)
    await sendMessage(
      userPhone,
      '✅ Appointment request submitted. Doctor will confirm shortly.'
    );

  } catch (err) {
    console.error('❌ AppointmentBooking handler error:', err);

    await sendMessage(
      userPhone,
      '❌ Booking failed. Please try again.'
    );
  }
}

module.exports = {
  handleBooking
};

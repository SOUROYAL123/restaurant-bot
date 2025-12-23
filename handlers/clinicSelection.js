// handlers/clinicSelection.js
const pool = require('../db');
const SessionManager = require('../utils/sessionManager');

async function handleClinicSelection(userPhone, message, session, twiml) {

  // If clinic already selected → do nothing
  if (session.clinic_id) return false;

  // First time → show clinic list
  if (!session.awaiting_clinic) {
    const res = await pool.query(
      `SELECT id, name FROM clinics WHERE status='active' ORDER BY id`
    );

    let reply = 'Please choose your clinic:\n\n';
    res.rows.forEach((c, i) => {
      reply += `${i + 1}. ${c.name}\n`;
    });

    twiml.message(reply);

    await SessionManager.updateSession(userPhone, null, {
      awaiting_clinic: true
    });

    return true;
  }

  // User selected a number
  const choice = parseInt(message.trim(), 10);
  if (isNaN(choice)) {
    twiml.message('Please reply with a number.');
    return true;
  }

  const clinics = await pool.query(
    `SELECT id, name FROM clinics WHERE status='active' ORDER BY id`
  );

  const selected = clinics.rows[choice - 1];
  if (!selected) {
    twiml.message('Invalid choice. Try again.');
    return true;
  }

  await SessionManager.updateSession(userPhone, null, {
    clinic_id: selected.id,
    awaiting_clinic: false,
    current_step: 'booking_start'
  });

  twiml.message(
    `✅ ${selected.name} selected.\n\nWhat is your full name?`
  );

  return true;
}

module.exports = { handleClinicSelection };

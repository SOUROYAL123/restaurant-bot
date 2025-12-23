const db = require('../db');

/**
 * Always ensures a session exists.
 * If not, it creates one.
 */
async function ensureSession(phone) {
  await db.query(
    `INSERT INTO sessions (phone, step)
     VALUES ($1, 'booking_start')
     ON CONFLICT (phone) DO NOTHING`,
    [phone]
  );
}

/**
 * Get session for a phone
 */
async function getSession(phone) {
  const res = await db.query(
    `SELECT * FROM sessions WHERE phone = $1`,
    [phone]
  );
  return res.rows[0];
}

/**
 * Update session safely
 */
async function updateSession(phone, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  for (const key in updates) {
    fields.push(`${key} = $${idx}`);
    values.push(updates[key]);
    idx++;
  }

  values.push(phone);

  const query = `
    UPDATE sessions
    SET ${fields.join(', ')}, updated_at = now()
    WHERE phone = $${idx}
  `;

  await db.query(query, values);
}

module.exports = {
  ensureSession,
  getSession,
  updateSession
};

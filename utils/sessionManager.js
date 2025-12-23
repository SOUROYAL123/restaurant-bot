const db = require('../db');

async function ensureSession(phone) {
  await db.query(
    `INSERT INTO sessions (phone, step)
     VALUES ($1, 'booking_start')
     ON CONFLICT (phone) DO NOTHING`,
    [phone]
  );
}

async function getSession(phone) {
  const res = await db.query(
    `SELECT * FROM sessions WHERE phone = $1`,
    [phone]
  );
  return res.rows[0];
}

async function updateSession(phone, updates) {
  const fields = [];
  const values = [];
  let i = 1;

  for (const key in updates) {
    fields.push(`${key} = $${i}`);
    values.push(updates[key]);
    i++;
  }

  values.push(phone);

  const query = `
    UPDATE sessions
    SET ${fields.join(', ')}, updated_at = now()
    WHERE phone = $${i}
  `;

  await db.query(query, values);
}

module.exports = {
  ensureSession,
  getSession,
  updateSession
};

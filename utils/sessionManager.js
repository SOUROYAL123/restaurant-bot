const db = require('../db');

async function ensureSession(userPhone) {
  await db.query(
    `INSERT INTO sessions (user_phone, step)
     VALUES ($1, 'booking_start')
     ON CONFLICT (user_phone) DO NOTHING`,
    [userPhone]
  );
}

async function getSession(userPhone) {
  const res = await db.query(
    `SELECT * FROM sessions WHERE user_phone = $1`,
    [userPhone]
  );
  return res.rows[0];
}

async function updateSession(userPhone, updates) {
  const fields = [];
  const values = [];
  let i = 1;

  for (const key in updates) {
    fields.push(`${key} = $${i}`);
    values.push(updates[key]);
    i++;
  }

  values.push(userPhone);

  const query = `
    UPDATE sessions
    SET ${fields.join(', ')}, updated_at = now()
    WHERE user_phone = $${i}
  `;

  await db.query(query, values);
}

module.exports = {
  ensureSession,
  getSession,
  updateSession
};

const pool = require('../db');

async function getSession(userPhone, clinicId) {
  const res = await pool.query(
    `SELECT * FROM sessions WHERE user_phone = $1 AND clinic_id = $2 LIMIT 1`,
    [userPhone, clinicId]
  );
  return res.rows[0] || null;
}

async function createSession(userPhone, clinicId) {
  const res = await pool.query(
    `INSERT INTO sessions (user_phone, clinic_id, current_step, created_at)
     VALUES ($1, $2, 'booking_start', NOW())
     RETURNING *`,
    [userPhone, clinicId]
  );
  return res.rows[0];
}

async function updateSession(userPhone, clinicId, updates) {
  const fields = [];
  const values = [];
  let i = 1;

  for (const key in updates) {
    fields.push(`${key} = $${i++}`);
    values.push(updates[key]);
  }

  await pool.query(
    `UPDATE sessions SET ${fields.join(', ')}, updated_at = NOW()
     WHERE user_phone = $${i++} AND clinic_id = $${i}`,
    [...values, userPhone, clinicId]
  );
}

async function clearSession(userPhone, clinicId) {
  await pool.query(
    `DELETE FROM sessions WHERE user_phone = $1 AND clinic_id = $2`,
    [userPhone, clinicId]
  );
}

module.exports = {
  getSession,
  createSession,
  updateSession,
  clearSession
};

// utils/sessionManager.js
const pool = require('../db');

async function getSession(userPhone, clinicId) {
  const res = await pool.query(
    `SELECT * FROM sessions 
     WHERE user_phone = $1 AND clinic_id = $2 
     LIMIT 1`,
    [userPhone, clinicId]
  );
  return res.rows[0] || null;
}

async function createSession(userPhone, clinicId) {
  const res = await pool.query(
    `INSERT INTO sessions 
     (user_phone, clinic_id, current_step, language, created_at)
     VALUES ($1, $2, 'booking_start', 'en', NOW())
     RETURNING *`,
    [userPhone, clinicId]
  );
  return res.rows[0];
}

async function updateSession(userPhone, clinicId, updates) {
  const keys = Object.keys(updates);
  if (!keys.length) return;

  const fields = [];
  const values = [];
  let i = 1;

  for (const key of keys) {
    fields.push(`${key} = $${i++}`);
    values.push(updates[key]);
  }

  await pool.query(
    `UPDATE sessions 
     SET ${fields.join(', ')}, updated_at = NOW()
     WHERE user_phone = $${i++} AND clinic_id = $${i}`,
    [...values, userPhone, clinicId]
  );
}

async function clearSession(userPhone, clinicId) {
  await pool.query(
    `DELETE FROM sessions 
     WHERE user_phone = $1 AND clinic_id = $2`,
    [userPhone, clinicId]
  );
}

/* ✅ THIS WAS MISSING */
async function setUserLanguage(userPhone, clinicId, language) {
  await pool.query(
    `UPDATE sessions 
     SET language = $1, updated_at = NOW()
     WHERE user_phone = $2 AND clinic_id = $3`,
    [language, userPhone, clinicId]
  );
}

module.exports = {
  getSession,
  createSession,
  updateSession,
  clearSession,
  setUserLanguage
};

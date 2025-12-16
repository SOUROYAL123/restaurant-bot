const pool = require('../db');

async function getClinics() {
  const result = await pool.query(
    'SELECT id, name FROM clinics WHERE status = $1 ORDER BY id',
    ['active']
  );
  return result.rows;
}

async function setClinicSession(userPhone, clinicId) {
  await pool.query(
    `INSERT INTO sessions (user_phone, clinic_id, current_step, updated_at)
     VALUES ($1, $2, 'clinic_selected', NOW())
     ON CONFLICT (user_phone) 
     DO UPDATE SET clinic_id = $2, current_step = 'clinic_selected', updated_at = NOW()`,
    [userPhone, clinicId]
  );
}

async function getSession(userPhone) {
  const result = await pool.query(
    'SELECT * FROM sessions WHERE user_phone = $1',
    [userPhone]
  );
  return result.rows[0] || null;
}

module.exports = { getClinics, setClinicSession, getSession };
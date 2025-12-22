const pool = require('../db');

async function getClinicByWaba(wabaNumber) {
  const res = await pool.query(
    `SELECT * FROM clinics WHERE waba_number = $1 AND status = 'active' LIMIT 1`,
    [wabaNumber]
  );
  return res.rows[0] || null;
}

module.exports = { getClinicByWaba };

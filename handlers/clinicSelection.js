const pool = require('../db');

/**
 * Get all active clinics from database
 */
async function getClinics() {
  try {
    const result = await pool.query(
      'SELECT id, name FROM clinics WHERE status = $1 ORDER BY id',
      ['active']
    );
    return result.rows;
  } catch (error) {
    console.error('❌ Error fetching clinics:', error);
    throw error;
  }
}

/**
 * Create or update session with selected clinic
 */
async function setClinicSession(userPhone, clinicId) {
  try {
    // First, get the clinic name
    const clinicResult = await pool.query(
      'SELECT name FROM clinics WHERE id = $1',
      [clinicId]
    );
    
    if (clinicResult.rows.length === 0) {
      throw new Error(`Clinic ${clinicId} not found`);
    }
    
    const clinicName = clinicResult.rows[0].name;
    
    // Now insert/update session WITH temp_data
    await pool.query(
      `INSERT INTO sessions (user_phone, clinic_id, current_step, temp_data, updated_at)
       VALUES ($1, $2, 'clinic_selected', $3, NOW())
       ON CONFLICT (user_phone) 
       DO UPDATE SET 
         clinic_id = $2, 
         current_step = 'clinic_selected',
         temp_data = $3,
         updated_at = NOW()`,
      [userPhone, clinicId, JSON.stringify({ clinic_name: clinicName })]
    );
    
    console.log(`✅ Session created for ${userPhone} with clinic ${clinicId}`);
    
  } catch (error) {
    console.error('❌ Error setting clinic session:', error);
    throw error;
  }
}

/**
 * Get user's current session
 */
async function getSession(userPhone) {
  try {
    const result = await pool.query(
      'SELECT * FROM sessions WHERE user_phone = $1',
      [userPhone]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('❌ Error getting session:', error);
    throw error;
  }
}

/**
 * Clear user session
 */
async function clearSession(userPhone) {
  try {
    await pool.query(
      'DELETE FROM sessions WHERE user_phone = $1',
      [userPhone]
    );
  } catch (error) {
    console.error('❌ Error clearing session:', error);
    throw error;
  }
}

module.exports = {
  getClinics,
  setClinicSession,
  getSession,
  clearSession
};

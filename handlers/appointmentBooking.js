const pool = require('../db');

/**
 * Save new appointment with status
 */
async function saveAppointment(clinicId, patientName, patientPhone, date, slot, status = 'confirmed') {
  try {
    const result = await pool.query(
      `INSERT INTO appointments 
       (clinic_id, patient_name, patient_phone, appointment_date, appointment_slot, status, booked_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id`,
      [clinicId, patientName, patientPhone, date, slot, status]
    );
    
    console.log(`✅ Appointment saved with ID: ${result.rows[0].id}, Status: ${status}`);
    return result.rows[0].id;
  } catch (error) {
    console.error('❌ Error saving appointment:', error);
    throw error;
  }
}

/**
 * Get available time slots (exclude confirmed AND pending)
 */
async function getAvailableSlots(clinicId, date) {
  try {
    const bookedSlots = await pool.query(
      `SELECT appointment_slot FROM appointments 
       WHERE clinic_id = $1 
       AND appointment_date = $2 
       AND status IN ('confirmed', 'pending')`,
      [clinicId, date]
    );
    
    const allSlots = [
      '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM',
      '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM'
    ];
    
    const booked = bookedSlots.rows.map(row => row.appointment_slot);
    const available = allSlots.filter(slot => !booked.includes(slot));
    
    return available;
  } catch (error) {
    console.error('❌ Error getting available slots:', error);
    throw error;
  }
}

/**
 * Check if current time is within business hours
 */
async function isBusinessHours(clinicId) {
  try {
    const result = await pool.query(
      `SELECT business_hours_start, business_hours_end, auto_approve 
       FROM clinics WHERE id = $1`,
      [clinicId]
    );
    
    if (result.rows.length === 0) return true; // Default to business hours
    
    const { business_hours_start, business_hours_end, auto_approve } = result.rows[0];
    
    if (!auto_approve) return false; // Manual approval required
    
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes(); // Minutes since midnight
    
    const startTime = parseInt(business_hours_start.split(':')[0]) * 60 + 
                     parseInt(business_hours_start.split(':')[1]);
    const endTime = parseInt(business_hours_end.split(':')[0]) * 60 + 
                   parseInt(business_hours_end.split(':')[1]);
    
    return currentTime >= startTime && currentTime <= endTime;
  } catch (error) {
    console.error('❌ Error checking business hours:', error);
    return true; // Default to auto-approve on error
  }
}

/**
 * Update appointment status
 */
async function updateAppointmentStatus(appointmentId, status) {
  try {
    const timestamp = status === 'confirmed' ? ', confirmed_at = NOW()' : '';
    await pool.query(
      `UPDATE appointments 
       SET status = $1 ${timestamp}
       WHERE id = $2`,
      [status, appointmentId]
    );
    console.log(`✅ Appointment ${appointmentId} status updated to: ${status}`);
  } catch (error) {
    console.error('❌ Error updating appointment status:', error);
    throw error;
  }
}

/**
 * Get appointment details
 */
async function getAppointment(appointmentId) {
  try {
    const result = await pool.query(
      `SELECT a.*, c.name as clinic_name 
       FROM appointments a
       JOIN clinics c ON a.clinic_id = c.id
       WHERE a.id = $1`,
      [appointmentId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('❌ Error getting appointment:', error);
    throw error;
  }
}

module.exports = {
  saveAppointment,
  getAvailableSlots,
  isBusinessHours,
  updateAppointmentStatus,
  getAppointment
};

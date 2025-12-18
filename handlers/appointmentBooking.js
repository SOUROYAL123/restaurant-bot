const pool = require('../db');
const { createOrUpdateCustomer, logInteraction } = require('../utils/customerSync');

/**
 * Save new appointment with customer tracking
 */
async function saveAppointment(clinicId, patientName, patientPhone, date, slot, status = 'confirmed', language = 'en') {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Step 1: Create or update customer record
    const customerId = await createOrUpdateCustomer(patientName, patientPhone, language);
    
    // Step 2: Get assigned doctor (use primary doctor for clinic)
    const doctorResult = await client.query(
      'SELECT primary_doctor_id FROM clinics WHERE id = $1',
      [clinicId]
    );
    const doctorId = doctorResult.rows[0]?.primary_doctor_id || null;
    
    // Step 3: Create appointment with customer_id and doctor_id
    const result = await client.query(
      `INSERT INTO appointments 
       (clinic_id, customer_id, doctor_id, patient_name, patient_phone, 
        appointment_date, appointment_slot, status, booked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING id`,
      [clinicId, customerId, doctorId, patientName, patientPhone, date, slot, status]
    );
    
    const appointmentId = result.rows[0].id;
    
    // Step 4: Log interaction
    await logInteraction(
      customerId, 
      clinicId, 
      'booking_attempt', 
      `Booked appointment for ${date} at ${slot}`
    );
    
    await client.query('COMMIT');
    
    console.log(`✅ Appointment saved - ID: ${appointmentId}, Customer: ${customerId}, Status: ${status}`);
    return appointmentId;
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error saving appointment:', error);
    throw error;
  } finally {
    client.release();
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
    
    if (result.rows.length === 0) return true;
    
    const { business_hours_start, business_hours_end, auto_approve } = result.rows[0];
    
    if (!auto_approve) return false;
    
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    
    const startTime = parseInt(business_hours_start.split(':')[0]) * 60 + 
                     parseInt(business_hours_start.split(':')[1]);
    const endTime = parseInt(business_hours_end.split(':')[0]) * 60 + 
                   parseInt(business_hours_end.split(':')[1]);
    
    return currentTime >= startTime && currentTime <= endTime;
  } catch (error) {
    console.error('❌ Error checking business hours:', error);
    return true;
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
 * Get appointment details with customer info
 */
async function getAppointment(appointmentId) {
  try {
    const result = await pool.query(
      `SELECT 
        a.*,
        c.name as clinic_name,
        cu.name as customer_name,
        cu.phone as customer_phone,
        cu.email as customer_email,
        cu.total_appointments as customer_total_appointments,
        d.name as doctor_name,
        d.whatsapp as doctor_whatsapp
       FROM appointments a
       JOIN clinics c ON a.clinic_id = c.id
       LEFT JOIN customers cu ON a.customer_id = cu.id
       LEFT JOIN doctors d ON a.doctor_id = d.id
       WHERE a.id = $1`,
      [appointmentId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('❌ Error getting appointment:', error);
    throw error;
  }
}

/**
 * Get customer appointment history
 */
async function getCustomerHistory(customerPhone) {
  try {
    const result = await pool.query(
      `SELECT 
        a.id,
        a.appointment_date,
        a.appointment_slot,
        a.status,
        c.name as clinic_name,
        d.name as doctor_name
       FROM appointments a
       JOIN clinics c ON a.clinic_id = c.id
       LEFT JOIN doctors d ON a.doctor_id = d.id
       LEFT JOIN customers cu ON a.customer_id = cu.id
       WHERE cu.phone LIKE $1
       ORDER BY a.appointment_date DESC, a.appointment_slot DESC
       LIMIT 10`,
      [`%${customerPhone.replace(/\D/g, '')}%`]
    );
    return result.rows;
  } catch (error) {
    console.error('❌ Error getting customer history:', error);
    throw error;
  }
}

/**
 * Add appointment notes
 */
async function addAppointmentNotes(appointmentId, notes) {
  try {
    await pool.query(
      'UPDATE appointments SET appointment_notes = $1 WHERE id = $2',
      [notes, appointmentId]
    );
    console.log(`✅ Notes added to appointment ${appointmentId}`);
  } catch (error) {
    console.error('❌ Error adding notes:', error);
    throw error;
  }
}

/**
 * Add feedback to appointment
 */
async function addAppointmentFeedback(appointmentId, rating, comment) {
  try {
    await pool.query(
      `UPDATE appointments 
       SET feedback_rating = $1, feedback_comment = $2 
       WHERE id = $3`,
      [rating, comment, appointmentId]
    );
    console.log(`✅ Feedback added to appointment ${appointmentId}`);
  } catch (error) {
    console.error('❌ Error adding feedback:', error);
    throw error;
  }
}

/**
 * Get upcoming appointments for a clinic
 */
async function getUpcomingAppointments(clinicId, days = 7) {
  try {
    const result = await pool.query(
      `SELECT 
        a.id,
        a.appointment_date,
        a.appointment_slot,
        a.status,
        cu.name as customer_name,
        cu.phone as customer_phone,
        d.name as doctor_name
       FROM appointments a
       LEFT JOIN customers cu ON a.customer_id = cu.id
       LEFT JOIN doctors d ON a.doctor_id = d.id
       WHERE a.clinic_id = $1
         AND a.appointment_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $2
         AND a.status IN ('confirmed', 'pending')
       ORDER BY a.appointment_date, a.appointment_slot`,
      [clinicId, `${days} days`]
    );
    return result.rows;
  } catch (error) {
    console.error('❌ Error getting upcoming appointments:', error);
    throw error;
  }
}

/**
 * Check for appointment conflicts
 */
async function hasConflict(clinicId, doctorId, date, slot) {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as count 
       FROM appointments 
       WHERE clinic_id = $1 
         AND (doctor_id = $2 OR doctor_id IS NULL)
         AND appointment_date = $3 
         AND appointment_slot = $4
         AND status IN ('confirmed', 'pending')`,
      [clinicId, doctorId, date, slot]
    );
    return result.rows[0].count > 0;
  } catch (error) {
    console.error('❌ Error checking conflicts:', error);
    return false;
  }
}

module.exports = {
  saveAppointment,
  getAvailableSlots,
  isBusinessHours,
  updateAppointmentStatus,
  getAppointment,
  getCustomerHistory,
  addAppointmentNotes,
  addAppointmentFeedback,
  getUpcomingAppointments,
  hasConflict
};

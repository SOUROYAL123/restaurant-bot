const pool = require('../db');

async function saveAppointment(clinicId, patientName, patientPhone, date, slot) {
  const result = await pool.query(
    `INSERT INTO appointments 
     (clinic_id, patient_name, patient_phone, appointment_date, appointment_slot)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [clinicId, patientName, patientPhone, date, slot]
  );
  return result.rows[0].id;
}

async function getAvailableSlots(clinicId, date) {
  const bookedSlots = await pool.query(
    `SELECT appointment_slot FROM appointments 
     WHERE clinic_id = $1 AND appointment_date = $2 AND status = 'confirmed'`,
    [clinicId, date]
  );
  
  const allSlots = [
    '9:00 AM', '10:00 AM', '11:00 AM', 
    '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM'
  ];
  
  const booked = bookedSlots.rows.map(r => r.appointment_slot);
  return allSlots.filter(slot => !booked.includes(slot));
}

module.exports = { saveAppointment, getAvailableSlots };
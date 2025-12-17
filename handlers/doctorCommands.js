const pool = require('../db');
const { updateAppointmentStatus, getAppointment } = require('./appointmentBooking');

/**
 * Check if message is from a doctor
 */
async function isDoctor(phoneNumber) {
  try {
    const result = await pool.query(
      'SELECT id FROM clinics WHERE doctor_whatsapp = $1',
      [phoneNumber]
    );
    return result.rows.length > 0;
  } catch (error) {
    console.error('❌ Error checking if doctor:', error);
    return false;
  }
}

/**
 * Handle doctor commands (APPROVE, REJECT, CANCEL)
 */
async function handleDoctorCommand(phoneNumber, message, twilioClient) {
  const normalizedMessage = message.trim().toUpperCase();
  
  // Check for APPROVE command
  const approveMatch = normalizedMessage.match(/^APPROVE\s+(\d+)$/);
  if (approveMatch) {
    const appointmentId = parseInt(approveMatch[1]);
    return await approveAppointment(appointmentId, twilioClient);
  }
  
  // Check for REJECT command
  const rejectMatch = normalizedMessage.match(/^REJECT\s+(\d+)$/);
  if (rejectMatch) {
    const appointmentId = parseInt(rejectMatch[1]);
    return await rejectAppointment(appointmentId, twilioClient);
  }
  
  // Check for CANCEL command
  const cancelMatch = normalizedMessage.match(/^CANCEL\s+(\d+)$/);
  if (cancelMatch) {
    const appointmentId = parseInt(cancelMatch[1]);
    return await cancelAppointment(appointmentId, twilioClient);
  }
  
  return null; // Not a command
}

/**
 * Approve pending appointment
 */
async function approveAppointment(appointmentId, twilioClient) {
  try {
    const appointment = await getAppointment(appointmentId);
    
    if (!appointment) {
      return `❌ Appointment #${appointmentId} not found.`;
    }
    
    if (appointment.status !== 'pending') {
      return `⚠️ Appointment #${appointmentId} is already ${appointment.status}.`;
    }
    
    await updateAppointmentStatus(appointmentId, 'confirmed');
    
    // Notify patient
    const [year, month, day] = appointment.appointment_date.split('-');
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${appointment.patient_phone}`,
      body: `🎉 *Appointment CONFIRMED!*

🏥 *Clinic:* ${appointment.clinic_name}
👤 *Name:* ${appointment.patient_name}
📅 *Date:* ${day}-${month}-${year}
⏰ *Time:* ${appointment.appointment_slot}
📌 *Booking ID:* #${appointmentId}

✨ Your appointment has been approved!
See you soon! 👋`
    });
    
    return `✅ Appointment #${appointmentId} APPROVED\n\nPatient ${appointment.patient_name} has been notified.`;
    
  } catch (error) {
    console.error('❌ Error approving appointment:', error);
    return `❌ Error approving appointment #${appointmentId}`;
  }
}

/**
 * Reject pending appointment
 */
async function rejectAppointment(appointmentId, twilioClient) {
  try {
    const appointment = await getAppointment(appointmentId);
    
    if (!appointment) {
      return `❌ Appointment #${appointmentId} not found.`;
    }
    
    if (appointment.status !== 'pending') {
      return `⚠️ Appointment #${appointmentId} is already ${appointment.status}.`;
    }
    
    await updateAppointmentStatus(appointmentId, 'rejected');
    
    // Notify patient
    const [year, month, day] = appointment.appointment_date.split('-');
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${appointment.patient_phone}`,
      body: `😔 *Appointment Request Not Approved*

📌 *Request ID:* #${appointmentId}
🏥 *Clinic:* ${appointment.clinic_name}
📅 *Date:* ${day}-${month}-${year}
⏰ *Time:* ${appointment.appointment_slot}

The requested slot is not available.
Type "hi" to book a different time.`
    });
    
    return `❌ Appointment #${appointmentId} REJECTED\n\nPatient has been notified. Slot is now available.`;
    
  } catch (error) {
    console.error('❌ Error rejecting appointment:', error);
    return `❌ Error rejecting appointment #${appointmentId}`;
  }
}

/**
 * Cancel confirmed appointment
 */
async function cancelAppointment(appointmentId, twilioClient) {
  try {
    const appointment = await getAppointment(appointmentId);
    
    if (!appointment) {
      return `❌ Appointment #${appointmentId} not found.`;
    }
    
    if (appointment.status === 'cancelled') {
      return `⚠️ Appointment #${appointmentId} is already cancelled.`;
    }
    
    await updateAppointmentStatus(appointmentId, 'cancelled');
    
    // Notify patient
    const [year, month, day] = appointment.appointment_date.split('-');
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${appointment.patient_phone}`,
      body: `⚠️ *Appointment Cancelled*

📌 *Booking ID:* #${appointmentId}
🏥 *Clinic:* ${appointment.clinic_name}
📅 *Date:* ${day}-${month}-${year}
⏰ *Time:* ${appointment.appointment_slot}

Your appointment has been cancelled by the clinic.
Please contact them or book a new slot.

Type "hi" to make a new booking.`
    });
    
    return `✅ Appointment #${appointmentId} CANCELLED\n\nPatient has been notified. Slot is now available.`;
    
  } catch (error) {
    console.error('❌ Error cancelling appointment:', error);
    return `❌ Error cancelling appointment #${appointmentId}`;
  }
}

module.exports = {
  isDoctor,
  handleDoctorCommand
};

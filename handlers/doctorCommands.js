const pool = require('../db');
const { updateAppointmentStatus, getAppointment } = require('./appointmentBooking');

async function isDoctorAndGetClinicId(phoneNumber) {
  try {
    const result = await pool.query('SELECT id FROM clinics WHERE doctor_whatsapp = $1', [phoneNumber]);
    return result.rows.length > 0 ? result.rows[0].id : null;
  } catch (error) {
    console.error('❌ Error checking if doctor:', error);
    return null;
  }
}

async function isDoctor(phoneNumber) {
  const clinicId = await isDoctorAndGetClinicId(phoneNumber);
  return clinicId !== null;
}

async function handleDoctorCommand(phoneNumber, message, twilioClient) {
  const normalizedMessage = message.trim().toUpperCase();
  const clinicId = await isDoctorAndGetClinicId(phoneNumber);
  
  if (!clinicId) return null;
  
  if (normalizedMessage === 'AUTO ON') {
    return await enableAutoApproval(clinicId);
  }
  
  if (normalizedMessage === 'AUTO OFF') {
    return await disableAutoApproval(clinicId);
  }
  
  if (normalizedMessage === 'STATUS') {
    return await getClinicStatus(clinicId);
  }
  
  const approveMatch = normalizedMessage.match(/^APPROVE\s+(\d+)$/);
  if (approveMatch) {
    const appointmentId = parseInt(approveMatch[1]);
    return await approveAppointment(appointmentId, twilioClient);
  }
  
  const rejectMatch = normalizedMessage.match(/^REJECT\s+(\d+)$/);
  if (rejectMatch) {
    const appointmentId = parseInt(rejectMatch[1]);
    return await rejectAppointment(appointmentId, twilioClient);
  }
  
  const cancelMatch = normalizedMessage.match(/^CANCEL\s+(\d+)$/);
  if (cancelMatch) {
    const appointmentId = parseInt(cancelMatch[1]);
    return await cancelAppointment(appointmentId, twilioClient);
  }
  
  return null;
}

async function enableAutoApproval(clinicId) {
  try {
    await pool.query('UPDATE clinics SET auto_approve = true WHERE id = $1', [clinicId]);
    return `✅ *Auto-Approval ENABLED*\n\nNew bookings during business hours will be confirmed instantly.\n\nBookings outside business hours will still need approval.\n\nTo disable: Reply "AUTO OFF"\nTo check status: Reply "STATUS"`;
  } catch (error) {
    console.error('❌ Error enabling auto-approval:', error);
    return '❌ Error updating settings.';
  }
}

async function disableAutoApproval(clinicId) {
  try {
    await pool.query('UPDATE clinics SET auto_approve = false WHERE id = $1', [clinicId]);
    return `⚠️ *Auto-Approval DISABLED*\n\nALL new bookings will need your approval, regardless of time.\n\nYou'll receive approval requests for every booking.\n\nTo enable: Reply "AUTO ON"\nTo check status: Reply "STATUS"`;
  } catch (error) {
    console.error('❌ Error disabling auto-approval:', error);
    return '❌ Error updating settings.';
  }
}

async function getClinicStatus(clinicId) {
  try {
    const result = await pool.query('SELECT name, auto_approve, business_hours_start, business_hours_end FROM clinics WHERE id = $1', [clinicId]);
    
    if (result.rows.length === 0) {
      return '❌ Clinic not found.';
    }
    
    const clinic = result.rows[0];
    
    const pendingResult = await pool.query('SELECT COUNT(*) as count FROM appointments WHERE clinic_id = $1 AND status = $2', [clinicId, 'pending']);
    const pendingCount = pendingResult.rows[0].count;
    
    const todayResult = await pool.query('SELECT COUNT(*) as count FROM appointments WHERE clinic_id = $1 AND status = $2 AND appointment_date = CURRENT_DATE', [clinicId, 'confirmed']);
    const todayCount = todayResult.rows[0].count;
    
    const startTime = clinic.business_hours_start.substring(0, 5);
    const endTime = clinic.business_hours_end.substring(0, 5);
    const autoStatus = clinic.auto_approve ? '✅ ENABLED' : '❌ DISABLED';
    
    return `📊 *Clinic Status*\n\n🏥 *${clinic.name}*\n\n*Auto-Approval:* ${autoStatus}\n*Business Hours:* ${startTime} - ${endTime}\n\n*Appointments:*\n📅 Today: ${todayCount} confirmed\n⏳ Pending: ${pendingCount}\n\n${clinic.auto_approve ? 'Bookings during business hours = Auto-confirmed\nBookings outside hours = Need approval' : 'ALL bookings need your approval'}\n\n*Commands:*\n• AUTO ON - Enable auto-approval\n• AUTO OFF - Disable auto-approval\n• APPROVE [ID] - Approve pending\n• REJECT [ID] - Reject pending\n• CANCEL [ID] - Cancel booking`;
  } catch (error) {
    console.error('❌ Error getting clinic status:', error);
    return '❌ Error retrieving status.';
  }
}

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
    
    const [year, month, day] = appointment.appointment_date.split('-');
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${appointment.patient_phone}`,
      body: `🎉 *Appointment CONFIRMED!*\n\n🏥 *Clinic:* ${appointment.clinic_name}\n👤 *Name:* ${appointment.patient_name}\n📅 *Date:* ${day}-${month}-${year}\n⏰ *Time:* ${appointment.appointment_slot}\n📌 *Booking ID:* #${appointmentId}\n\n✨ Your appointment has been approved!\nSee you soon! 👋`
    });
    
    return `✅ *Appointment #${appointmentId} APPROVED*\n\nPatient: ${appointment.patient_name}\nDate: ${day}-${month}-${year}\nTime: ${appointment.appointment_slot}\n\nPatient has been notified.`;
  } catch (error) {
    console.error('❌ Error approving appointment:', error);
    return `❌ Error approving appointment #${appointmentId}`;
  }
}

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
    
    const [year, month, day] = appointment.appointment_date.split('-');
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${appointment.patient_phone}`,
      body: `😔 *Appointment Request Not Approved*\n\n📌 *Request ID:* #${appointmentId}\n🏥 *Clinic:* ${appointment.clinic_name}\n📅 *Date:* ${day}-${month}-${year}\n⏰ *Time:* ${appointment.appointment_slot}\n\nThe requested slot is not available.\nType "hi" to book a different time.`
    });
    
    return `❌ *Appointment #${appointmentId} REJECTED*\n\nPatient: ${appointment.patient_name}\nDate: ${day}-${month}-${year}\n\nPatient has been notified. Slot is now available.`;
  } catch (error) {
    console.error('❌ Error rejecting appointment:', error);
    return `❌ Error rejecting appointment #${appointmentId}`;
  }
}

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
    
    const [year, month, day] = appointment.appointment_date.split('-');
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${appointment.patient_phone}`,
      body: `⚠️ *Appointment Cancelled*\n\n📌 *Booking ID:* #${appointmentId}\n🏥 *Clinic:* ${appointment.clinic_name}\n📅 *Date:* ${day}-${month}-${year}\n⏰ *Time:* ${appointment.appointment_slot}\n\nYour appointment has been cancelled by the clinic.\nPlease contact them or book a new slot.\n\nType "hi" to make a new booking.`
    });
    
    return `✅ *Appointment #${appointmentId} CANCELLED*\n\nPatient: ${appointment.patient_name}\nDate: ${day}-${month}-${year}\n\nPatient has been notified. Slot is now available.`;
  } catch (error) {
    console.error('❌ Error cancelling appointment:', error);
    return `❌ Error cancelling appointment #${appointmentId}`;
  }
}

module.exports = {
  isDoctor,
  handleDoctorCommand
};

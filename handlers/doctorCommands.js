const pool = require('../db');
const { updateAppointmentStatus, getAppointment } = require('./appointmentBooking');

/**
 * Check if message is from a doctor and return clinic ID
 */
async function isDoctorAndGetClinicId(phoneNumber) {
  try {
    const result = await pool.query(
      'SELECT id FROM clinics WHERE doctor_whatsapp = $1',
      [phoneNumber]
    );
    return result.rows.length > 0 ? result.rows[0].id : null;
  } catch (error) {
    console.error('❌ Error checking if doctor:', error);
    return null;
  }
}

/**
 * Check if message is from a doctor (legacy compatibility)
 */
async function isDoctor(phoneNumber) {
  const clinicId = await isDoctorAndGetClinicId(phoneNumber);
  return clinicId !== null;
}

/**
 * Handle doctor commands (APPROVE, REJECT, CANCEL, AUTO ON/OFF, STATUS)
 */
async function handleDoctorCommand(phoneNumber, message, twilioClient) {
  const normalizedMessage = message.trim().toUpperCase();
  const clinicId = await isDoctorAndGetClinicId(phoneNumber);
  
  if (!clinicId) return null; // Not a doctor
  
  // Check for AUTO ON command
  if (normalizedMessage === 'AUTO ON') {
    return await enableAutoApproval(clinicId);
  }
  
  // Check for AUTO OFF command
  if (normalizedMessage === 'AUTO OFF') {
    return await disableAutoApproval(clinicId);
  }
  
  // Check for STATUS command
  if (normalizedMessage === 'STATUS') {
    return await getClinicStatus(clinicId);
  }
  
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
 * Enable auto-approval
 */
async function enableAutoApproval(clinicId) {
  try {
    await pool.query(
      'UPDATE clinics SET auto_approve = true WHERE id = $1',
      [clinicId]
    );
    
    return `✅ *Auto-Approval ENABLED*

New bookings during business hours will be confirmed instantly.

Bookings outside business hours will still need approval.

To disable: Reply "AUTO OFF"
To check status: Reply "STATUS"`;
    
  } catch (error) {
    console.error('❌ Error enabling auto-approval:', error);
    return '❌ Error updating settings.';
  }
}

/**
 * Disable auto-approval
 */
async function disableAutoApproval(clinicId) {
  try {
    await pool.query(
      'UPDATE clinics SET auto_approve = false WHERE id = $1',
      [clinicId]
    );
    
    return `⚠️ *Auto-Approval DISABLED*

ALL new bookings will need your approval, regardless of time.

You'll receive approval requests for every booking.

To enable: Reply "AUTO ON"
To check status: Reply "STATUS"`;
    
  } catch (error) {
    console.error('❌ Error disabling auto-approval:', error);
    return '❌ Error updating settings.';
  }
}

/**
 * Get clinic status
 */
async function getClinicStatus(clinicId) {
  try {
    const result = await pool.query(
      `SELECT 
        name,
        auto_approve,
        business_hours_start,
        business_hours_end
       FROM clinics 
       WHERE id = $1`,
      [clinicId]
    );
    
    if (result.rows.length === 0) {
      return '❌ Clinic not found.';
    }
    
    const clinic = result.rows[0];
    
    // Get pending appointments count
    const pendingResult = await pool.query(
      `SELECT COUNT(*) as count 
       FROM appointments 
       WHERE clinic_id = $1 AND status = 'pending'`,
      [clinicId]
    );
    
    const pendingCount = pendingResult.rows[0].count;
    
    // Get today's confirmed appointments
    const todayResult = await pool.query(
      `SELECT COUNT(*) as count 
       FROM appointments 
       WHERE clinic_id = $1 
       AND status = 'confirmed' 
       AND appointment_date = CURRENT_DATE`,
      [clinicId]
    );
    
    const todayCount = todayResult.rows[0].count;
    
    // Format business hours
    const startTime = clinic.business_hours_start.substring(0, 5);
    const endTime = clinic.business_hours_end.substring(0, 5);
    
    const autoStatus = clinic.auto_approve ? '✅ ENABLED' : '❌ DISABLED';
    
    return `📊 *Clinic Status*

🏥 *${clinic.name}*

*Auto-Approval:* ${autoStatus}
*Business Hours:* ${startTime} - ${endTime}

*Appointments:*
📅 Today: ${todayCount} confirmed
⏳ Pending: ${pendingCount}

${clinic.auto_approve ? 
  'Bookings during business hours = Auto-confirmed\nBookings outside hours = Need approval' : 
  'ALL bookings need your approval'}

*Commands:*
- AUTO ON - Enable auto-approval
- AUTO OFF - Disable auto-approval
- APPROVE [ID] - Approve pending
- REJECT [ID] - Reject pending
- CANCEL [ID] - Cancel booking`;
    
  } catch (error) {
    console.error('❌ Error getting clinic status:', error);
    return '❌ Error retrieving status.';
  }
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
    
    return `✅ *Appointment #${appointmentId} APPROVED*

Patient: ${appointment.patient_name}
Date: ${day}-${month}-${year}
Time: ${appointment.appointment_slot}

Patient has been notified.`;
    
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
    
    return `❌ *Appointment #${appointmentId} REJECTED*

Patient: ${appointment.patient_name}
Date: ${day}-${month}-${year}

Patient has been notified. Slot is now available.`;
    
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
    
    return `✅ *Appointment #${appointmentId} CANCELLED*

Patient: ${appointment.patient_name}
Date: ${day}-${month}-${year}

Patient has been notified. Slot is now available.`;
    
  } catch (error) {
    console.error('❌ Error cancelling appointment:', error);
    return `❌ Error cancelling appointment #${appointmentId}`;
  }
}

module.exports = {
  isDoctor,
  handleDoctorCommand
};
```

**Click "Commit changes"**

---

## **THAT'S IT! DONE!**

Wait 2 minutes for Render to deploy.

---

## **HOW IT WORKS NOW:**

### **Doctor Tests:**
```
Doctor: "STATUS"
Bot: 📊 Clinic Status
     
     🏥 Dr Sharma Clinic
     Auto-Approval: ✅ ENABLED
     Business Hours: 09:00 - 21:00
     
     Appointments:
     📅 Today: 3 confirmed
     ⏳ Pending: 1
```
```
Doctor: "AUTO OFF"
Bot: ⚠️ Auto-Approval DISABLED
     
     ALL new bookings will need your approval,
     regardless of time.
```

Now if patient books at 2 PM:
→ Goes to PENDING (not auto-confirmed)
```
Doctor: "AUTO ON"
Bot: ✅ Auto-Approval ENABLED
     
     New bookings during business hours
     will be confirmed instantly.
```

Now if patient books at 2 PM:
→ INSTANT CONFIRMATION ✅

---

## **COMPLETE DOCTOR COMMAND LIST:**
```
AUTO ON       → Enable auto-approval
AUTO OFF      → Disable auto-approval  
STATUS        → Check current settings
APPROVE 5     → Approve pending #5
REJECT 5      → Reject pending #5
CANCEL 5      → Cancel confirmed #5
```

---

## **TEST IT:**

### **Test 1: Check Status**
From doctor's WhatsApp send:
```
STATUS
```

### **Test 2: Turn Off Auto-Approval**
```
AUTO OFF
```

Then have a patient book → Should go to PENDING

### **Test 3: Turn On Auto-Approval**
```
AUTO ON

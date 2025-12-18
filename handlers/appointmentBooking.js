const db = require('../config/database');
const { incrementAppointments, logInteraction } = require('../utils/customerSync');

/**
 * Book a new appointment
 */
async function bookAppointment(phoneNumber, clinicId, appointmentData) {
    try {
        const { name, date, time, service } = appointmentData;
        
        // Parse date to ensure proper format
        const appointmentDate = parseDate(date);
        const appointmentTime = parseTime(time);
        
        // Check if appointment slot is available
        const isAvailable = await checkAvailability(clinicId, appointmentDate, appointmentTime);
        
        if (!isAvailable) {
            throw new Error('Time slot not available');
        }
        
        // Insert appointment into database
        const result = await db.query(
            `INSERT INTO appointments 
             (clinic_id, customer_phone, customer_name, appointment_date, appointment_time, service, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             RETURNING *`,
            [clinicId, phoneNumber, name, appointmentDate, appointmentTime, service || 'General Consultation', 'pending']
        );
        
        const appointment = result.rows[0];
        
        // Update customer appointment count
        await incrementAppointments(phoneNumber, clinicId);
        
        // Log this booking interaction
        await logInteraction(
            phoneNumber,
            clinicId,
            'booking_completed',
            `Appointment booked for ${appointmentDate} at ${appointmentTime}`,
            `Appointment #${appointment.id} confirmed`
        );
        
        console.log(`✅ Appointment booked: #${appointment.id} for ${phoneNumber}`);
        
        return appointment;
        
    } catch (error) {
        console.error('❌ Booking error:', error);
        
        // Log failed booking attempt
        await logInteraction(
            phoneNumber,
            clinicId,
            'booking_failed',
            JSON.stringify(appointmentData),
            error.message
        ).catch(logError => console.error('Failed to log error:', logError));
        
        throw error;
    }
}

/**
 * Check if appointment slot is available
 */
async function checkAvailability(clinicId, date, time) {
    try {
        const result = await db.query(
            `SELECT COUNT(*) as count 
             FROM appointments 
             WHERE clinic_id = $1 
             AND appointment_date = $2 
             AND appointment_time = $3 
             AND status != 'cancelled'`,
            [clinicId, date, time]
        );
        
        // Assuming each slot can have max 1 appointment (adjust as needed)
        const maxAppointmentsPerSlot = 1;
        return parseInt(result.rows[0].count) < maxAppointmentsPerSlot;
        
    } catch (error) {
        console.error('Error checking availability:', error);
        return true; // Fail open - allow booking if check fails
    }
}

/**
 * Get appointments for a customer
 */
async function getCustomerAppointments(phoneNumber, clinicId, limit = 10) {
    try {
        const result = await db.query(
            `SELECT * FROM appointments 
             WHERE customer_phone = $1 
             AND clinic_id = $2 
             ORDER BY appointment_date DESC, appointment_time DESC 
             LIMIT $3`,
            [phoneNumber, clinicId, limit]
        );
        
        return result.rows;
        
    } catch (error) {
        console.error('Error fetching appointments:', error);
        return [];
    }
}

/**
 * Get upcoming appointments for a clinic
 */
async function getClinicAppointments(clinicId, date = new Date(), limit = 50) {
    try {
        const result = await db.query(
            `SELECT * FROM appointments 
             WHERE clinic_id = $1 
             AND appointment_date >= $2 
             AND status != 'cancelled'
             ORDER BY appointment_date ASC, appointment_time ASC 
             LIMIT $3`,
            [clinicId, date.toISOString().split('T')[0], limit]
        );
        
        return result.rows;
        
    } catch (error) {
        console.error('Error fetching clinic appointments:', error);
        return [];
    }
}

/**
 * Cancel an appointment
 */
async function cancelAppointment(appointmentId, phoneNumber, clinicId) {
    try {
        const result = await db.query(
            `UPDATE appointments 
             SET status = 'cancelled', 
                 updated_at = NOW() 
             WHERE id = $1 
             AND customer_phone = $2 
             AND clinic_id = $3 
             AND status = 'pending'
             RETURNING *`,
            [appointmentId, phoneNumber, clinicId]
        );
        
        if (result.rows.length === 0) {
            throw new Error('Appointment not found or already cancelled');
        }
        
        // Log cancellation
        await logInteraction(
            phoneNumber,
            clinicId,
            'booking_cancelled',
            `Appointment #${appointmentId} cancelled`,
            'Cancellation confirmed'
        );
        
        console.log(`✅ Appointment cancelled: #${appointmentId}`);
        
        return result.rows[0];
        
    } catch (error) {
        console.error('Error cancelling appointment:', error);
        throw error;
    }
}

/**
 * Reschedule an appointment
 */
async function rescheduleAppointment(appointmentId, phoneNumber, clinicId, newDate, newTime) {
    try {
        const parsedDate = parseDate(newDate);
        const parsedTime = parseTime(newTime);
        
        // Check if new slot is available
        const isAvailable = await checkAvailability(clinicId, parsedDate, parsedTime);
        
        if (!isAvailable) {
            throw new Error('New time slot not available');
        }
        
        const result = await db.query(
            `UPDATE appointments 
             SET appointment_date = $1,
                 appointment_time = $2,
                 updated_at = NOW() 
             WHERE id = $3 
             AND customer_phone = $4 
             AND clinic_id = $5 
             AND status = 'pending'
             RETURNING *`,
            [parsedDate, parsedTime, appointmentId, phoneNumber, clinicId]
        );
        
        if (result.rows.length === 0) {
            throw new Error('Appointment not found or cannot be rescheduled');
        }
        
        // Log reschedule
        await logInteraction(
            phoneNumber,
            clinicId,
            'booking_rescheduled',
            `Appointment #${appointmentId} rescheduled to ${parsedDate} at ${parsedTime}`,
            'Reschedule confirmed'
        );
        
        console.log(`✅ Appointment rescheduled: #${appointmentId}`);
        
        return result.rows[0];
        
    } catch (error) {
        console.error('Error rescheduling appointment:', error);
        throw error;
    }
}

/**
 * Confirm an appointment (mark as confirmed)
 */
async function confirmAppointment(appointmentId, clinicId) {
    try {
        const result = await db.query(
            `UPDATE appointments 
             SET status = 'confirmed',
                 updated_at = NOW() 
             WHERE id = $1 
             AND clinic_id = $2 
             AND status = 'pending'
             RETURNING *`,
            [appointmentId, clinicId]
        );
        
        if (result.rows.length === 0) {
            throw new Error('Appointment not found or already confirmed');
        }
        
        console.log(`✅ Appointment confirmed: #${appointmentId}`);
        
        return result.rows[0];
        
    } catch (error) {
        console.error('Error confirming appointment:', error);
        throw error;
    }
}

/**
 * Mark appointment as completed
 */
async function completeAppointment(appointmentId, clinicId) {
    try {
        const result = await db.query(
            `UPDATE appointments 
             SET status = 'completed',
                 updated_at = NOW() 
             WHERE id = $1 
             AND clinic_id = $2 
             AND status IN ('pending', 'confirmed')
             RETURNING *`,
            [appointmentId, clinicId]
        );
        
        if (result.rows.length === 0) {
            throw new Error('Appointment not found or cannot be completed');
        }
        
        console.log(`✅ Appointment completed: #${appointmentId}`);
        
        return result.rows[0];
        
    } catch (error) {
        console.error('Error completing appointment:', error);
        throw error;
    }
}

/**
 * Get available time slots for a specific date
 */
async function getAvailableSlots(clinicId, date) {
    try {
        const parsedDate = parseDate(date);
        
        // Define clinic hours (customize per clinic if needed)
        const workingHours = [
            '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
            '12:00', '12:30', '14:00', '14:30', '15:00', '15:30',
            '16:00', '16:30', '17:00', '17:30'
        ];
        
        // Get booked slots
        const result = await db.query(
            `SELECT appointment_time 
             FROM appointments 
             WHERE clinic_id = $1 
             AND appointment_date = $2 
             AND status != 'cancelled'`,
            [clinicId, parsedDate]
        );
        
        const bookedSlots = result.rows.map(row => row.appointment_time);
        
        // Filter available slots
        const availableSlots = workingHours.filter(slot => !bookedSlots.includes(slot));
        
        return availableSlots;
        
    } catch (error) {
        console.error('Error getting available slots:', error);
        return [];
    }
}

/**
 * Get appointment statistics
 */
async function getAppointmentStats(clinicId, startDate, endDate) {
    try {
        const result = await db.query(
            `SELECT 
                COUNT(*) as total_appointments,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
                COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
                COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled
             FROM appointments 
             WHERE clinic_id = $1 
             AND appointment_date BETWEEN $2 AND $3`,
            [clinicId, startDate, endDate]
        );
        
        return result.rows[0];
        
    } catch (error) {
        console.error('Error getting appointment stats:', error);
        return null;
    }
}

/**
 * Parse date from various formats
 */
function parseDate(dateString) {
    // Handle formats: DD/MM/YYYY, DD-MM-YYYY, DD MM YYYY
    const cleanDate = dateString.trim().replace(/\s+/g, '-').replace(/\//g, '-');
    const parts = cleanDate.split('-');
    
    if (parts.length === 3) {
        const day = parts[0].padStart(2, '0');
        const month = parts[1].padStart(2, '0');
        const year = parts[2].length === 2 ? '20' + parts[2] : parts[2];
        
        // Return ISO format: YYYY-MM-DD
        return `${year}-${month}-${day}`;
    }
    
    throw new Error('Invalid date format');
}

/**
 * Parse time from various formats
 */
function parseTime(timeString) {
    // Handle formats: HH:MM, HH:MM AM/PM, HH AM/PM
    const cleanTime = timeString.trim().toLowerCase();
    
    // Check for AM/PM format
    const isPM = cleanTime.includes('pm');
    const isAM = cleanTime.includes('am');
    
    // Extract numbers
    const timeMatch = cleanTime.match(/(\d{1,2})(?::(\d{2}))?/);
    
    if (timeMatch) {
        let hour = parseInt(timeMatch[1]);
        const minute = timeMatch[2] || '00';
        
        // Convert 12-hour to 24-hour format
        if (isPM && hour !== 12) {
            hour += 12;
        } else if (isAM && hour === 12) {
            hour = 0;
        }
        
        // Return HH:MM format
        return `${hour.toString().padStart(2, '0')}:${minute}`;
    }
    
    throw new Error('Invalid time format');
}

/**
 * Send appointment reminder (to be called by a scheduler)
 */
async function sendAppointmentReminders(clinicId) {
    try {
        // Get appointments for tomorrow
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowDate = tomorrow.toISOString().split('T')[0];
        
        const result = await db.query(
            `SELECT * FROM appointments 
             WHERE clinic_id = $1 
             AND appointment_date = $2 
             AND status IN ('pending', 'confirmed')`,
            [clinicId, tomorrowDate]
        );
        
        // Return appointments that need reminders
        return result.rows;
        
    } catch (error) {
        console.error('Error fetching appointments for reminders:', error);
        return [];
    }
}

module.exports = {
    bookAppointment,
    checkAvailability,
    getCustomerAppointments,
    getClinicAppointments,
    cancelAppointment,
    rescheduleAppointment,
    confirmAppointment,
    completeAppointment,
    getAvailableSlots,
    getAppointmentStats,
    sendAppointmentReminders,
    parseDate,
    parseTime
};

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
        const appointmentSlot = time; // Keep original format for appointment_slot
        
        // Insert appointment into database with correct column names
        const result = await db.query(
            `INSERT INTO appointments 
             (clinic_id, patient_phone, patient_name, appointment_date, appointment_slot, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             RETURNING *`,
            [
                clinicId, 
                phoneNumber, 
                name, 
                appointmentDate, 
                appointmentSlot,
                'pending'
            ]
        );
        
        const appointment = result.rows[0];
        
        // Update customer appointment count
        await incrementAppointments(phoneNumber, clinicId);
        
        // Log this booking interaction
        await logInteraction(
            phoneNumber,
            clinicId,
            'booking_completed',
            `Appointment booked for ${appointmentDate} at ${appointmentSlot}`,
            `Appointment #${appointment.id} confirmed`
        );
        
        console.log(`✅ Appointment booked: #${appointment.id} for ${phoneNumber}`);
        
        return appointment;
        
    } catch (error) {
        console.error('❌ Booking error:', error.message);
        console.error('❌ Full error:', error);
        
        // Log failed booking attempt
        await logInteraction(
            phoneNumber,
            clinicId,
            'booking_failed',
            JSON.stringify(appointmentData),
            error.message
        ).catch(logError => console.error('Failed to log error:', logError.message));
        
        throw error;
    }
}

/**
 * Check if appointment slot is available
 */
async function checkAvailability(clinicId, date, slot) {
    try {
        const result = await db.query(
            `SELECT COUNT(*) as count 
             FROM appointments 
             WHERE clinic_id = $1 
             AND appointment_date = $2 
             AND appointment_slot = $3 
             AND status != 'cancelled'`,
            [clinicId, date, slot]
        );
        
        const maxAppointmentsPerSlot = 1;
        return parseInt(result.rows[0].count) < maxAppointmentsPerSlot;
        
    } catch (error) {
        console.error('❌ Error checking availability:', error.message);
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
             WHERE patient_phone = $1 
             AND clinic_id = $2 
             ORDER BY appointment_date DESC, created_at DESC 
             LIMIT $3`,
            [phoneNumber, clinicId, limit]
        );
        
        return result.rows;
        
    } catch (error) {
        console.error('❌ Error fetching appointments:', error.message);
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
             ORDER BY appointment_date ASC, appointment_slot ASC 
             LIMIT $3`,
            [clinicId, date.toISOString().split('T')[0], limit]
        );
        
        return result.rows;
        
    } catch (error) {
        console.error('❌ Error fetching clinic appointments:', error.message);
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
             SET status = 'cancelled'
             WHERE id = $1 
             AND patient_phone = $2 
             AND clinic_id = $3 
             AND status = 'pending'
             RETURNING *`,
            [appointmentId, phoneNumber, clinicId]
        );
        
        if (result.rows.length === 0) {
            throw new Error('Appointment not found or already cancelled');
        }
        
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
        console.error('❌ Error cancelling appointment:', error.message);
        throw error;
    }
}

/**
 * Confirm an appointment
 */
async function confirmAppointment(appointmentId, clinicId) {
    try {
        const result = await db.query(
            `UPDATE appointments 
             SET status = 'confirmed',
                 confirmed_at = NOW()
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
        console.error('❌ Error confirming appointment:', error.message);
        throw error;
    }
}

/**
 * Parse date from various formats to YYYY-MM-DD
 */
function parseDate(dateString) {
    try {
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
    } catch (error) {
        console.error('❌ Date parsing error:', error.message, 'Input:', dateString);
        throw new Error('Invalid date format. Please use DD-MM-YYYY');
    }
}

/**
 * Parse time from various formats (kept for compatibility, but stores original)
 */
function parseTime(timeString) {
    try {
        // Handle formats: HH:MM, HH:MM AM/PM, HH AM/PM, H.MM AM/PM
        const cleanTime = timeString.trim().toLowerCase().replace(/\./g, ':');
        
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
    } catch (error) {
        console.error('❌ Time parsing error:', error.message, 'Input:', timeString);
        throw new Error('Invalid time format. Please use HH:MM or HH:MM AM/PM');
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
            '09:00 AM', '09:30 AM', '10:00 AM', '10:30 AM', '11:00 AM', '11:30 AM',
            '12:00 PM', '12:30 PM', '02:00 PM', '02:30 PM', '03:00 PM', '03:30 PM',
            '04:00 PM', '04:30 PM', '05:00 PM', '05:30 PM'
        ];
        
        // Get booked slots
        const result = await db.query(
            `SELECT appointment_slot 
             FROM appointments 
             WHERE clinic_id = $1 
             AND appointment_date = $2 
             AND status != 'cancelled'`,
            [clinicId, parsedDate]
        );
        
        const bookedSlots = result.rows.map(row => row.appointment_slot);
        
        // Filter available slots
        const availableSlots = workingHours.filter(slot => !bookedSlots.includes(slot));
        
        return availableSlots;
        
    } catch (error) {
        console.error('❌ Error getting available slots:', error.message);
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
        console.error('❌ Error getting appointment stats:', error.message);
        return null;
    }
}

module.exports = {
    bookAppointment,
    checkAvailability,
    getCustomerAppointments,
    getClinicAppointments,
    cancelAppointment,
    confirmAppointment,
    getAvailableSlots,
    getAppointmentStats,
    parseDate,
    parseTime
};

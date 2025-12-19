/**
 * ═══════════════════════════════════════════════════════════
 * APPOINTMENT BOOKING HANDLER
 * Handles the complete appointment booking flow with doctor approval
 * ═══════════════════════════════════════════════════════════
 */

const db = require('../config/database');
const { sendWhatsAppMessage } = require('../utils/twilioClient');
const DoctorCommandsHandler = require('./doctorCommands');

/**
 * Main appointment booking flow handler
 */
async function handleAppointmentBooking(session, messageBody, userPhone) {
    try {
        const stage = session.current_step;
        const tempData = session.temp_data || {};
        
        console.log(`📋 Appointment stage: ${stage}, Message: ${messageBody}`);
        
        // Route to appropriate stage handler
        switch (stage) {
            case 'booking_start':
                return await handleBookingStart(session, userPhone);
                
            case 'booking_name':
                return await handleName(session, messageBody, userPhone);
                
            case 'booking_date':
                return await handleDate(session, messageBody, userPhone);
                
            case 'booking_time':
                return await handleTime(session, messageBody, userPhone);
                
            case 'booking_confirm':
                return await handleConfirmation(session, messageBody, userPhone);
                
            default:
                return await handleBookingStart(session, userPhone);
        }
        
    } catch (error) {
        console.error('❌ Appointment booking error:', error.message);
        return {
            success: false,
            message: '❌ Sorry, something went wrong. Please try again.\n\nReply "1" to start booking.',
            nextStage: 'main_menu'
        };
    }
}

/**
 * STAGE 1: Start booking - Ask for name
 */
async function handleBookingStart(session, userPhone) {
    try {
        // Check if customer exists
        const customer = await db.query(
            `SELECT name FROM customers WHERE phone = $1 AND clinic_id = $2 LIMIT 1`,
            [userPhone, session.clinic_id]
        );
        
        let message = '';
        let tempData = {};
        
        if (customer.rows.length > 0 && customer.rows[0].name) {
            // Existing customer with name
            const name = customer.rows[0].name;
            tempData.name = name;
            
            message = `📝 *Book Your Appointment*\n\n` +
                `👤 Name: ${name}\n\n` +
                `📅 *Please provide appointment date*\n` +
                `Format: DD-MM-YYYY\n` +
                `Example: 25-12-2025\n\n` +
                `Or reply "CHANGE NAME" to use different name`;
            
            return {
                success: true,
                message: message,
                nextStage: 'booking_date',
                tempData: tempData
            };
        } else {
            // New customer or no name stored
            message = `📝 *Book Your Appointment*\n\n` +
                `👤 *Step 1/4: What is your name?*\n\n` +
                `Please type your full name:`;
            
            return {
                success: true,
                message: message,
                nextStage: 'booking_name',
                tempData: {}
            };
        }
        
    } catch (error) {
        console.error('Error in booking start:', error.message);
        throw error;
    }
}

/**
 * STAGE 2: Handle name input
 */
async function handleName(session, messageBody, userPhone) {
    try {
        const name = messageBody.trim();
        
        // Validation
        if (name.length < 2) {
            return {
                success: false,
                message: '❌ Please enter a valid name (at least 2 characters).\n\nType your full name:',
                nextStage: 'booking_name'
            };
        }
        
        if (name.length > 100) {
            return {
                success: false,
                message: '❌ Name is too long. Please enter a shorter name:',
                nextStage: 'booking_name'
            };
        }
        
        // Check for numbers in name
        if (/\d/.test(name)) {
            return {
                success: false,
                message: '❌ Name should not contain numbers.\n\nPlease enter your name:',
                nextStage: 'booking_name'
            };
        }
        
        const message = `📝 *Book Your Appointment*\n\n` +
            `👤 Name: ${name}\n\n` +
            `📅 *Step 2/4: Choose appointment date*\n\n` +
            `Format: DD-MM-YYYY\n` +
            `Example: 25-12-2025 or 25/12/2025\n\n` +
            `Please enter date:`;
        
        return {
            success: true,
            message: message,
            nextStage: 'booking_date',
            tempData: { name: name }
        };
        
    } catch (error) {
        console.error('Error handling name:', error.message);
        throw error;
    }
}

/**
 * STAGE 3: Handle date input
 */
async function handleDate(session, messageBody, userPhone) {
    try {
        const tempData = session.temp_data || {};
        const dateInput = messageBody.trim();
        
        // Handle "CHANGE NAME" command
        if (dateInput.toUpperCase() === 'CHANGE NAME') {
            return {
                success: true,
                message: '👤 *Please enter your name:*',
                nextStage: 'booking_name',
                tempData: {}
            };
        }
        
        // Parse and validate date
        const parsedDate = parseDate(dateInput);
        
        if (!parsedDate.valid) {
            return {
                success: false,
                message: `❌ ${parsedDate.error}\n\n` +
                    `Please enter date in format:\n` +
                    `DD-MM-YYYY (e.g., 25-12-2025)\n` +
                    `or DD/MM/YYYY (e.g., 25/12/2025)`,
                nextStage: 'booking_date'
            };
        }
        
        // Check if date is in the past
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const appointmentDate = new Date(parsedDate.date);
        
        if (appointmentDate < today) {
            return {
                success: false,
                message: '❌ Cannot book appointments in the past.\n\nPlease enter a future date:',
                nextStage: 'booking_date'
            };
        }
        
        // Check if date is too far in future (e.g., more than 90 days)
        const maxDate = new Date();
        maxDate.setDate(maxDate.getDate() + 90);
        
        if (appointmentDate > maxDate) {
            return {
                success: false,
                message: '❌ Cannot book appointments more than 90 days in advance.\n\nPlease enter a closer date:',
                nextStage: 'booking_date'
            };
        }
        
        // Format date nicely
        const formattedDate = appointmentDate.toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
            weekday: 'long'
        });
        
        const message = `📝 *Book Your Appointment*\n\n` +
            `👤 Name: ${tempData.name}\n` +
            `📅 Date: ${formattedDate}\n\n` +
            `🕒 *Step 3/4: Choose time*\n\n` +
            `Format: HH:MM AM/PM\n` +
            `Examples:\n` +
            `• 10:00 AM\n` +
            `• 2:30 PM\n` +
            `• 11.30AM\n\n` +
            `Please enter time:`;
        
        return {
            success: true,
            message: message,
            nextStage: 'booking_time',
            tempData: { 
                ...tempData, 
                date: parsedDate.date,
                date_display: formattedDate
            }
        };
        
    } catch (error) {
        console.error('Error handling date:', error.message);
        throw error;
    }
}

/**
 * STAGE 4: Handle time input
 */
async function handleTime(session, messageBody, userPhone) {
    try {
        const tempData = session.temp_data || {};
        const timeInput = messageBody.trim();
        
        // Parse and validate time
        const parsedTime = parseTime(timeInput);
        
        if (!parsedTime.valid) {
            return {
                success: false,
                message: `❌ ${parsedTime.error}\n\n` +
                    `Please enter time in format:\n` +
                    `HH:MM AM/PM\n\n` +
                    `Examples:\n` +
                    `• 10:00 AM\n` +
                    `• 2:30 PM\n` +
                    `• 11.30AM`,
                nextStage: 'booking_time'
            };
        }
        
        // Get clinic business hours
        const clinic = await db.query(
            `SELECT business_hours_start, business_hours_end FROM clinics WHERE id = $1`,
            [session.clinic_id]
        );
        
        if (clinic.rows.length > 0) {
            const businessStart = clinic.rows[0].business_hours_start;
            const businessEnd = clinic.rows[0].business_hours_end;
            
            // Validate if time is within business hours (optional)
            // You can add this validation if needed
        }
        
        // Check for existing appointments at same time (optional conflict check)
        const conflict = await db.query(
            `SELECT id FROM appointments 
             WHERE clinic_id = $1 
             AND appointment_date = $2 
             AND appointment_slot = $3 
             AND status IN ('pending', 'confirmed')
             LIMIT 1`,
            [session.clinic_id, tempData.date, parsedTime.time]
        );
        
        if (conflict.rows.length > 0) {
            return {
                success: false,
                message: `⚠️ This time slot is already booked.\n\n` +
                    `Please choose a different time:`,
                nextStage: 'booking_time'
            };
        }
        
        const message = `📋 *Confirm Your Appointment*\n\n` +
            `👤 Name: ${tempData.name}\n` +
            `📅 Date: ${tempData.date_display}\n` +
            `🕒 Time: ${parsedTime.time}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `✅ *Reply "YES" to confirm*\n` +
            `❌ *Reply "NO" to cancel*\n` +
            `📝 *Reply "EDIT" to change details*`;
        
        return {
            success: true,
            message: message,
            nextStage: 'booking_confirm',
            tempData: { 
                ...tempData, 
                time: parsedTime.time,
                time_display: parsedTime.display
            }
        };
        
    } catch (error) {
        console.error('Error handling time:', error.message);
        throw error;
    }
}

/**
 * STAGE 5: Handle confirmation
 */
async function handleConfirmation(session, messageBody, userPhone) {
    try {
        const response = messageBody.trim().toUpperCase();
        const tempData = session.temp_data || {};
        
        if (response === 'YES' || response === 'Y' || response === 'CONFIRM') {
            return await confirmBooking(session, userPhone, tempData);
        } 
        else if (response === 'NO' || response === 'N' || response === 'CANCEL') {
            return {
                success: true,
                message: '❌ Booking cancelled.\n\nReply "1" to start a new booking.',
                nextStage: 'main_menu'
            };
        }
        else if (response === 'EDIT' || response === 'CHANGE') {
            return {
                success: true,
                message: '📝 Let\'s start over.\n\n👤 What is your name?',
                nextStage: 'booking_name',
                tempData: {}
            };
        }
        else {
            return {
                success: false,
                message: '❓ Please reply:\n• "YES" to confirm\n• "NO" to cancel\n• "EDIT" to change',
                nextStage: 'booking_confirm'
            };
        }
        
    } catch (error) {
        console.error('Error handling confirmation:', error.message);
        throw error;
    }
}

/**
 * FINAL STEP: Confirm and create appointment
 */
async function confirmBooking(session, userPhone, tempData) {
    try {
        console.log('💾 Creating appointment...');
        
        const { name, date, time } = tempData;
        
        // Get or create customer
        let customerId;
        const customerCheck = await db.query(
            `SELECT id FROM customers WHERE phone = $1 AND clinic_id = $2 LIMIT 1`,
            [userPhone, session.clinic_id]
        );
        
        if (customerCheck.rows.length > 0) {
            customerId = customerCheck.rows[0].id;
            
            // Update customer name if different
            await db.query(
                `UPDATE customers 
                 SET name = $1, last_contact_date = NOW(), updated_at = NOW()
                 WHERE id = $2`,
                [name, customerId]
            );
        } else {
            // Create new customer
            const newCustomer = await db.query(
                `INSERT INTO customers 
                 (phone, name, clinic_id, preferred_language, first_contact_date, last_contact_date, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW(), NOW())
                 RETURNING id`,
                [userPhone, name, session.clinic_id, session.language || 'en']
            );
            customerId = newCustomer.rows[0].id;
        }
        
        // Create appointment with PENDING status (requires doctor approval)
        const appointmentResult = await db.query(
            `INSERT INTO appointments 
             (clinic_id, patient_name, patient_phone, appointment_date, 
              appointment_slot, status, customer_id, booked_at, created_at)
             VALUES ($1, $2, $3, $4, $5, 'pending', $6, NOW(), NOW())
             RETURNING id`,
            [session.clinic_id, name, userPhone, date, time, customerId]
        );
        
        const appointmentId = appointmentResult.rows[0].id;
        
        console.log(`✅ Appointment created: #${appointmentId}`);
        
        // Get clinic details
        const clinicResult = await db.query(
            `SELECT id, name, doctor_name, doctor_whatsapp FROM clinics WHERE id = $1`,
            [session.clinic_id]
        );
        
        if (clinicResult.rows.length === 0) {
            throw new Error('Clinic not found');
        }
        
        const clinicInfo = clinicResult.rows[0];
        
        // Prepare appointment data for doctor notification
        const appointmentData = {
            id: appointmentId,
            patient_name: name,
            patient_phone: userPhone,
            appointment_date: date,
            appointment_slot: time
        };
        
        // SEND NOTIFICATION TO DOCTOR
        console.log('📤 Notifying doctor...');
        const doctorNotified = await DoctorCommandsHandler.notifyDoctorNewAppointment(
            appointmentData, 
            clinicInfo
        );
        
        if (doctorNotified) {
            console.log('✅ Doctor notified successfully');
        } else {
            console.log('⚠️ Failed to notify doctor');
        }
        
        // Update customer stats
        await db.query(
            `UPDATE customers 
             SET total_appointments = total_appointments + 1
             WHERE id = $1`,
            [customerId]
        );
        
        // Update clinic stats
        await db.query(
            `UPDATE clinics 
             SET total_appointments = total_appointments + 1
             WHERE id = $1`,
            [session.clinic_id]
        );
        
        // Format date for display
        const displayDate = new Date(date).toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
            weekday: 'long'
        });
        
        // Send confirmation message to patient (PENDING status)
        const patientMessage = `⏳ *Appointment Request Submitted!*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `📋 *Booking ID:* #${appointmentId}\n` +
            `👤 *Name:* ${name}\n` +
            `📅 *Date:* ${displayDate}\n` +
            `🕒 *Time:* ${time}\n` +
            `🏥 *Clinic:* ${clinicInfo.name}\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `⏳ *Status: Pending Doctor Approval*\n\n` +
            `Your appointment request has been sent to Dr. ${clinicInfo.doctor_name}.\n\n` +
            `✅ You'll receive confirmation shortly via WhatsApp! 📱\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `💬 Need help? Reply "HELP"\n` +
            `📅 Book another? Reply "1"`;
        
        return {
            success: true,
            message: patientMessage,
            nextStage: 'main_menu',
            tempData: {},
            appointmentId: appointmentId
        };
        
    } catch (error) {
        console.error('❌ Error confirming booking:', error.message);
        
        // Send user-friendly error message
        return {
            success: false,
            message: '❌ Sorry, we couldn\'t complete your booking.\n\n' +
                'Please try again or contact us directly.\n\n' +
                'Reply "1" to try booking again.',
            nextStage: 'main_menu'
        };
    }
}

/**
 * UTILITY: Parse date input
 * Supports: DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY
 */
function parseDate(dateInput) {
    try {
        // Remove extra spaces
        dateInput = dateInput.trim();
        
        // Try different separators
        let parts = [];
        if (dateInput.includes('-')) {
            parts = dateInput.split('-');
        } else if (dateInput.includes('/')) {
            parts = dateInput.split('/');
        } else if (dateInput.includes('.')) {
            parts = dateInput.split('.');
        } else {
            return { valid: false, error: 'Invalid date format. Use DD-MM-YYYY' };
        }
        
        if (parts.length !== 3) {
            return { valid: false, error: 'Invalid date format. Use DD-MM-YYYY' };
        }
        
        let day = parseInt(parts[0]);
        let month = parseInt(parts[1]);
        let year = parseInt(parts[2]);
        
        // Validate day, month, year
        if (isNaN(day) || isNaN(month) || isNaN(year)) {
            return { valid: false, error: 'Date must contain only numbers' };
        }
        
        if (day < 1 || day > 31) {
            return { valid: false, error: 'Invalid day. Must be between 1-31' };
        }
        
        if (month < 1 || month > 12) {
            return { valid: false, error: 'Invalid month. Must be between 1-12' };
        }
        
        if (year < 2024 || year > 2030) {
            return { valid: false, error: 'Invalid year. Use format: 2025' };
        }
        
        // Create date object (month is 0-indexed in JS)
        const date = new Date(year, month - 1, day);
        
        // Check if date is valid (handles invalid dates like 31st Feb)
        if (date.getDate() !== day || date.getMonth() !== month - 1 || date.getFullYear() !== year) {
            return { valid: false, error: 'Invalid date. Please check day/month combination' };
        }
        
        // Format as YYYY-MM-DD for database
        const formattedDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        
        return { valid: true, date: formattedDate };
        
    } catch (error) {
        console.error('Date parse error:', error.message);
        return { valid: false, error: 'Invalid date format' };
    }
}

/**
 * UTILITY: Parse time input
 * Supports: HH:MM AM/PM, HH.MM AM/PM, HHMM AM/PM, H:MM AM/PM
 */
function parseTime(timeInput) {
    try {
        // Remove extra spaces and convert to uppercase
        timeInput = timeInput.trim().toUpperCase().replace(/\s+/g, '');
        
        // Extract AM/PM
        let period = '';
        if (timeInput.includes('AM')) {
            period = 'AM';
            timeInput = timeInput.replace('AM', '');
        } else if (timeInput.includes('PM')) {
            period = 'PM';
            timeInput = timeInput.replace('PM', '');
        } else {
            return { valid: false, error: 'Please specify AM or PM' };
        }
        
        // Remove any remaining dots or colons
        timeInput = timeInput.replace(/[:.]/g, ':');
        
        // Split by colon
        let parts = timeInput.split(':');
        
        if (parts.length < 1 || parts.length > 2) {
            return { valid: false, error: 'Invalid time format' };
        }
        
        let hours = parseInt(parts[0]);
        let minutes = parts.length === 2 ? parseInt(parts[1]) : 0;
        
        // Validate
        if (isNaN(hours) || isNaN(minutes)) {
            return { valid: false, error: 'Time must contain only numbers' };
        }
        
        if (hours < 1 || hours > 12) {
            return { valid: false, error: 'Hours must be between 1-12' };
        }
        
        if (minutes < 0 || minutes > 59) {
            return { valid: false, error: 'Minutes must be between 0-59' };
        }
        
        // Format time nicely
        const formattedHours = String(hours).padStart(2, '0');
        const formattedMinutes = String(minutes).padStart(2, '0');
        const displayTime = `${hours}:${formattedMinutes} ${period}`;
        const storageTime = `${formattedHours}:${formattedMinutes} ${period}`;
        
        return { 
            valid: true, 
            time: storageTime,
            display: displayTime
        };
        
    } catch (error) {
        console.error('Time parse error:', error.message);
        return { valid: false, error: 'Invalid time format' };
    }
}

module.exports = {
    handleAppointmentBooking,
    parseDate,
    parseTime
};

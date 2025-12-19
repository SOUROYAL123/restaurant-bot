/**
 * ═══════════════════════════════════════════════════════════
 * PATIENT COMMANDS HANDLER
 * Handle cancel, view, reschedule commands
 * ═══════════════════════════════════════════════════════════
 */

const db = require('../config/database');
const { sendWhatsAppMessage } = require('../utils/twilioClient');

class PatientCommandsHandler {
    
    /**
     * Check if message is a patient command
     */
    static isPatientCommand(messageBody) {
        const command = messageBody.trim().toUpperCase();
        
        return command.startsWith('CANCEL ') ||
               command === 'MY APPOINTMENTS' ||
               command === 'VIEW APPOINTMENTS' ||
               command === 'APPOINTMENTS' ||
               command.startsWith('RESCHEDULE ');
    }
    
    /**
     * Route patient commands
     */
    static async handleCommand(userPhone, clinicId, messageBody) {
        try {
            const command = messageBody.trim().toUpperCase();
            
            if (command.startsWith('CANCEL ')) {
                return await this.handleCancel(userPhone, clinicId, command);
            }
            else if (command === 'MY APPOINTMENTS' || command === 'VIEW APPOINTMENTS' || command === 'APPOINTMENTS') {
                return await this.handleViewAppointments(userPhone, clinicId);
            }
            else if (command.startsWith('RESCHEDULE ')) {
                return await this.handleRescheduleRequest(userPhone, clinicId, command);
            }
            
            return null;
            
        } catch (error) {
            console.error('Error handling patient command:', error.message);
            return {
                success: false,
                message: '❌ Error processing command. Please try again.'
            };
        }
    }
    
    /**
     * CANCEL appointment
     */
    static async handleCancel(userPhone, clinicId, command) {
        try {
            // Extract appointment ID
            const appointmentId = command.replace('CANCEL', '').trim();
            
            if (!appointmentId || isNaN(appointmentId)) {
                return {
                    success: false,
                    message: '❌ Invalid format.\n\nUse: CANCEL 12\n\nTo see your appointments, reply: MY APPOINTMENTS'
                };
            }
            
            // Get appointment
            const appointment = await db.query(
                `SELECT a.*, c.name as customer_name 
                 FROM appointments a
                 LEFT JOIN customers c ON a.customer_id = c.id
                 WHERE a.id = $1 
                 AND a.patient_phone = $2 
                 AND a.clinic_id = $3`,
                [appointmentId, userPhone, clinicId]
            );
            
            if (appointment.rows.length === 0) {
                return {
                    success: false,
                    message: `❌ Appointment #${appointmentId} not found or doesn't belong to you.\n\nReply MY APPOINTMENTS to see your bookings.`
                };
            }
            
            const appt = appointment.rows[0];
            
            // Check if already cancelled
            if (appt.status === 'cancelled') {
                return {
                    success: false,
                    message: `⚠️ Appointment #${appointmentId} is already cancelled.`
                };
            }
            
            // Check if already completed
            if (appt.status === 'completed') {
                return {
                    success: false,
                    message: `⚠️ Cannot cancel completed appointment #${appointmentId}.`
                };
            }
            
            // Check if appointment is in the past
            const apptDate = new Date(appt.appointment_date);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            if (apptDate < today) {
                return {
                    success: false,
                    message: `⚠️ Cannot cancel past appointment #${appointmentId}.`
                };
            }
            
            // Update status to cancelled
            await db.query(
                `UPDATE appointments 
                 SET status = 'cancelled',
                     updated_at = NOW()
                 WHERE id = $1`,
                [appointmentId]
            );
            
            // Update customer stats
            await db.query(
                `UPDATE customers 
                 SET total_cancelled = total_cancelled + 1
                 WHERE phone = $1 AND clinic_id = $2`,
                [userPhone, clinicId]
            );
            
            // Notify doctor
            await this.notifyDoctorCancellation(appt, clinicId);
            
            // Format date
            const displayDate = new Date(appt.appointment_date).toLocaleDateString('en-IN', {
                day: '2-digit',
                month: 'long',
                year: 'numeric'
            });
            
            const message = `✅ *Appointment Cancelled*\n\n` +
                `📋 Booking ID: #${appointmentId}\n` +
                `👤 Name: ${appt.patient_name}\n` +
                `📅 Date: ${displayDate}\n` +
                `🕒 Time: ${appt.appointment_slot}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `Your appointment has been cancelled successfully.\n\n` +
                `📅 Need to rebook? Reply "1"`;
            
            return {
                success: true,
                message: message
            };
            
        } catch (error) {
            console.error('Error cancelling appointment:', error.message);
            return {
                success: false,
                message: '❌ Error cancelling appointment. Please try again.'
            };
        }
    }
    
    /**
     * VIEW appointments
     */
    static async handleViewAppointments(userPhone, clinicId) {
        try {
            // Get upcoming appointments
            const upcoming = await db.query(
                `SELECT * FROM appointments 
                 WHERE patient_phone = $1 
                 AND clinic_id = $2
                 AND appointment_date >= CURRENT_DATE
                 AND status IN ('pending', 'confirmed')
                 ORDER BY appointment_date, appointment_slot
                 LIMIT 10`,
                [userPhone, clinicId]
            );
            
            // Get past appointments
            const past = await db.query(
                `SELECT * FROM appointments 
                 WHERE patient_phone = $1 
                 AND clinic_id = $2
                 AND (appointment_date < CURRENT_DATE OR status IN ('completed', 'cancelled', 'rejected'))
                 ORDER BY appointment_date DESC, appointment_slot DESC
                 LIMIT 5`,
                [userPhone, clinicId]
            );
            
            if (upcoming.rows.length === 0 && past.rows.length === 0) {
                return {
                    success: true,
                    message: `📅 *Your Appointments*\n\n` +
                        `You don't have any appointments yet.\n\n` +
                        `📱 Book your first appointment!\n` +
                        `Reply "1" to start booking.`
                };
            }
            
            let message = `📅 *Your Appointments*\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
            
            // Upcoming appointments
            if (upcoming.rows.length > 0) {
                message += `📌 *Upcoming (${upcoming.rows.length}):*\n\n`;
                
                upcoming.rows.forEach((appt, index) => {
                    const date = new Date(appt.appointment_date).toLocaleDateString('en-IN', {
                        day: '2-digit',
                        month: 'short'
                    });
                    
                    const statusIcon = appt.status === 'confirmed' ? '✅' : '⏳';
                    const statusText = appt.status === 'confirmed' ? 'Confirmed' : 'Pending';
                    
                    message += `${index + 1}. ${statusIcon} *#${appt.id}* - ${statusText}\n`;
                    message += `   📅 ${date} | 🕒 ${appt.appointment_slot}\n`;
                    message += `   👤 ${appt.patient_name}\n`;
                    message += `   ↪️ Cancel: CANCEL ${appt.id}\n`;
                    message += `   ↪️ Reschedule: RESCHEDULE ${appt.id}\n\n`;
                });
            }
            
            // Past appointments
            if (past.rows.length > 0) {
                message += `\n📋 *Past (${past.rows.length}):*\n\n`;
                
                past.rows.forEach((appt, index) => {
                    const date = new Date(appt.appointment_date).toLocaleDateString('en-IN', {
                        day: '2-digit',
                        month: 'short'
                    });
                    
                    let statusIcon = '✔️';
                    if (appt.status === 'cancelled') statusIcon = '❌';
                    if (appt.status === 'rejected') statusIcon = '🚫';
                    
                    message += `${index + 1}. ${statusIcon} *#${appt.id}* - ${appt.status}\n`;
                    message += `   📅 ${date} | 🕒 ${appt.appointment_slot}\n\n`;
                });
            }
            
            message += `━━━━━━━━━━━━━━━━━━━━━\n`;
            message += `📱 Book new appointment: Reply "1"`;
            
            return {
                success: true,
                message: message
            };
            
        } catch (error) {
            console.error('Error viewing appointments:', error.message);
            return {
                success: false,
                message: '❌ Error loading appointments. Please try again.'
            };
        }
    }
    
    /**
     * RESCHEDULE appointment - Start flow
     */
    static async handleRescheduleRequest(userPhone, clinicId, command) {
        try {
            const appointmentId = command.replace('RESCHEDULE', '').trim();
            
            if (!appointmentId || isNaN(appointmentId)) {
                return {
                    success: false,
                    message: '❌ Invalid format.\n\nUse: RESCHEDULE 12'
                };
            }
            
            // Get appointment
            const appointment = await db.query(
                `SELECT * FROM appointments 
                 WHERE id = $1 
                 AND patient_phone = $2 
                 AND clinic_id = $3`,
                [appointmentId, userPhone, clinicId]
            );
            
            if (appointment.rows.length === 0) {
                return {
                    success: false,
                    message: `❌ Appointment #${appointmentId} not found.`
                };
            }
            
            const appt = appointment.rows[0];
            
            // Check status
            if (appt.status === 'completed') {
                return {
                    success: false,
                    message: `⚠️ Cannot reschedule completed appointment.`
                };
            }
            
            if (appt.status === 'cancelled') {
                return {
                    success: false,
                    message: `⚠️ This appointment is cancelled. Book new appointment instead.\n\nReply "1" to book.`
                };
            }
            
            const displayDate = new Date(appt.appointment_date).toLocaleDateString('en-IN');
            
            return {
                success: true,
                message: `📝 *Reschedule Appointment #${appointmentId}*\n\n` +
                    `Current booking:\n` +
                    `📅 ${displayDate}\n` +
                    `🕒 ${appt.appointment_slot}\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `📅 Enter NEW date (DD-MM-YYYY):\n` +
                    `Example: 28-12-2025`,
                nextStage: 'reschedule_date',
                tempData: {
                    reschedule_appointment_id: appointmentId,
                    original_date: appt.appointment_date,
                    original_time: appt.appointment_slot,
                    patient_name: appt.patient_name
                }
            };
            
        } catch (error) {
            console.error('Error in reschedule request:', error.message);
            return {
                success: false,
                message: '❌ Error processing reschedule. Please try again.'
            };
        }
    }
    
    /**
     * Notify doctor about cancellation
     */
    static async notifyDoctorCancellation(appointment, clinicId) {
        try {
            const clinic = await db.query(
                `SELECT doctor_whatsapp, doctor_name FROM clinics WHERE id = $1`,
                [clinicId]
            );
            
            if (clinic.rows.length === 0) return;
            
            const doctorPhone = clinic.rows[0].doctor_whatsapp.replace('whatsapp:', '');
            const displayDate = new Date(appointment.appointment_date).toLocaleDateString('en-IN');
            
            const message = `🔔 *Appointment Cancelled*\n\n` +
                `📋 Booking ID: #${appointment.id}\n` +
                `👤 Patient: ${appointment.patient_name}\n` +
                `📅 Date: ${displayDate}\n` +
                `🕒 Time: ${appointment.appointment_slot}\n\n` +
                `❌ Patient cancelled this appointment.`;
            
            await sendWhatsAppMessage(doctorPhone, message);
            
        } catch (error) {
            console.error('Error notifying doctor of cancellation:', error.message);
        }
    }
}

module.exports = PatientCommandsHandler;

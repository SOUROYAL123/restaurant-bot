const db = require('../config/database');
const { sendWhatsAppMessage } = require('../utils/twilioClient');

/**
 * ═══════════════════════════════════════════════════════════
 * DOCTOR COMMANDS HANDLER
 * Handles all doctor WhatsApp commands
 * ═══════════════════════════════════════════════════════════
 */

class DoctorCommandsHandler {
    
    /**
     * Check if message is from a doctor
     */
    static async isDoctor(phoneNumber) {
        try {
            const result = await db.query(
                `SELECT id, name, doctor_name, doctor_whatsapp, notification_language 
                 FROM clinics 
                 WHERE doctor_whatsapp = $1 AND status = 'active'
                 LIMIT 1`,
                [`whatsapp:${phoneNumber}`]
            );
            
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            console.error('Error checking doctor:', error.message);
            return null;
        }
    }
    
    /**
     * Main command router
     */
    static async handleCommand(doctorInfo, messageBody, fromNumber) {
        try {
            const command = messageBody.trim().toUpperCase();
            
            // Log command
            await this.logDoctorAction(doctorInfo.id, fromNumber, command);
            
            // Route to appropriate handler
            if (command.startsWith('APPROVE ')) {
                return await this.handleApprove(doctorInfo, command, fromNumber);
            } 
            else if (command.startsWith('REJECT ')) {
                return await this.handleReject(doctorInfo, command, fromNumber);
            }
            else if (command === 'TODAY' || command === 'TODAY\'S APPOINTMENTS') {
                return await this.handleToday(doctorInfo, fromNumber);
            }
            else if (command === 'PENDING' || command === 'PENDING APPROVALS') {
                return await this.handlePending(doctorInfo, fromNumber);
            }
            else if (command === 'TOMORROW' || command === 'TOMORROW\'S APPOINTMENTS') {
                return await this.handleTomorrow(doctorInfo, fromNumber);
            }
            else if (command === 'STATS' || command === 'STATISTICS') {
                return await this.handleStats(doctorInfo, fromNumber);
            }
            else if (command === 'HELP' || command === 'COMMANDS') {
                return await this.handleHelp(doctorInfo, fromNumber);
            }
            else {
                return await this.handleInvalidCommand(doctorInfo, fromNumber);
            }
            
        } catch (error) {
            console.error('Error handling doctor command:', error.message);
            return {
                success: false,
                message: '❌ Error processing command. Please try again.'
            };
        }
    }
    
    /**
     * APPROVE appointment
     */
    static async handleApprove(doctorInfo, command, fromNumber) {
        try {
            // Extract appointment ID
            const appointmentId = command.replace('APPROVE', '').trim();
            
            if (!appointmentId || isNaN(appointmentId)) {
                return {
                    success: false,
                    message: '❌ Invalid format. Use: APPROVE 12'
                };
            }
            
            // Get appointment details
            const appointment = await db.query(
                `SELECT a.*, c.name as customer_name, c.phone as customer_phone
                 FROM appointments a
                 LEFT JOIN customers c ON a.customer_id = c.id
                 WHERE a.id = $1 AND a.clinic_id = $2`,
                [appointmentId, doctorInfo.id]
            );
            
            if (appointment.rows.length === 0) {
                return {
                    success: false,
                    message: `❌ Appointment #${appointmentId} not found.`
                };
            }
            
            const appt = appointment.rows[0];
            
            // Check if already approved
            if (appt.status === 'confirmed') {
                return {
                    success: false,
                    message: `⚠️ Appointment #${appointmentId} is already confirmed.`
                };
            }
            
            // Update status to confirmed
            await db.query(
                `UPDATE appointments 
                 SET status = 'confirmed',
                     confirmed_at = NOW(),
                     doctor_action = 'approved',
                     doctor_action_at = NOW()
                 WHERE id = $1`,
                [appointmentId]
            );
            
            // Log action
            await this.logDoctorAction(
                doctorInfo.id, 
                fromNumber, 
                command, 
                appointmentId, 
                'Appointment approved'
            );
            
            // Notify patient
            await this.notifyPatientApproval(appt, doctorInfo);
            
            // Format date/time
            const apptDate = new Date(appt.appointment_date).toLocaleDateString('en-IN');
            const apptTime = appt.appointment_slot;
            
            return {
                success: true,
                message: `✅ *Appointment Approved!*

📋 Booking ID: #${appointmentId}
👤 Patient: ${appt.patient_name}
📞 Phone: ${appt.patient_phone}
📅 Date: ${apptDate}
🕒 Time: ${apptTime}

Patient has been notified! ✅`
            };
            
        } catch (error) {
            console.error('Error approving appointment:', error.message);
            return {
                success: false,
                message: '❌ Error approving appointment. Please try again.'
            };
        }
    }
    
    /**
     * REJECT appointment
     */
    static async handleReject(doctorInfo, command, fromNumber) {
        try {
            // Extract appointment ID
            const appointmentId = command.replace('REJECT', '').trim();
            
            if (!appointmentId || isNaN(appointmentId)) {
                return {
                    success: false,
                    message: '❌ Invalid format. Use: REJECT 12'
                };
            }
            
            // Get appointment details
            const appointment = await db.query(
                `SELECT a.*, c.name as customer_name, c.phone as customer_phone
                 FROM appointments a
                 LEFT JOIN customers c ON a.customer_id = c.id
                 WHERE a.id = $1 AND a.clinic_id = $2`,
                [appointmentId, doctorInfo.id]
            );
            
            if (appointment.rows.length === 0) {
                return {
                    success: false,
                    message: `❌ Appointment #${appointmentId} not found.`
                };
            }
            
            const appt = appointment.rows[0];
            
            // Update status to rejected
            await db.query(
                `UPDATE appointments 
                 SET status = 'rejected',
                     doctor_action = 'rejected',
                     doctor_action_at = NOW()
                 WHERE id = $1`,
                [appointmentId]
            );
            
            // Log action
            await this.logDoctorAction(
                doctorInfo.id, 
                fromNumber, 
                command, 
                appointmentId, 
                'Appointment rejected'
            );
            
            // Notify patient
            await this.notifyPatientRejection(appt, doctorInfo);
            
            return {
                success: true,
                message: `❌ *Appointment Rejected*

📋 Booking ID: #${appointmentId}
👤 Patient: ${appt.patient_name}
📞 Phone: ${appt.patient_phone}

Patient has been notified to reschedule. 📱`
            };
            
        } catch (error) {
            console.error('Error rejecting appointment:', error.message);
            return {
                success: false,
                message: '❌ Error rejecting appointment. Please try again.'
            };
        }
    }
    
    /**
     * Show TODAY's appointments
     */
    static async handleToday(doctorInfo, fromNumber) {
        try {
            const today = new Date().toISOString().split('T')[0];
            
            const appointments = await db.query(
                `SELECT a.*, c.name as customer_name
                 FROM appointments a
                 LEFT JOIN customers c ON a.customer_id = c.id
                 WHERE a.clinic_id = $1 
                 AND a.appointment_date = $2
                 AND a.status IN ('pending', 'confirmed')
                 ORDER BY a.appointment_slot`,
                [doctorInfo.id, today]
            );
            
            if (appointments.rows.length === 0) {
                return {
                    success: true,
                    message: `📅 *Today's Schedule*\n\n✨ No appointments today!\n\nYou have a free day. 🎉`
                };
            }
            
            let message = `📅 *Today's Schedule*\n`;
            message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
            
            const pending = appointments.rows.filter(a => a.status === 'pending');
            const confirmed = appointments.rows.filter(a => a.status === 'confirmed');
            
            if (confirmed.length > 0) {
                message += `✅ *Confirmed (${confirmed.length}):*\n\n`;
                confirmed.forEach((appt, index) => {
                    message += `${index + 1}. 🕒 ${appt.appointment_slot}\n`;
                    message += `   👤 ${appt.patient_name} (#${appt.id})\n`;
                    message += `   📞 ${appt.patient_phone}\n\n`;
                });
            }
            
            if (pending.length > 0) {
                message += `⏳ *Pending Approval (${pending.length}):*\n\n`;
                pending.forEach((appt, index) => {
                    message += `${index + 1}. 🕒 ${appt.appointment_slot}\n`;
                    message += `   👤 ${appt.patient_name} (#${appt.id})\n`;
                    message += `   📞 ${appt.patient_phone}\n`;
                    message += `   ➡️ Reply: APPROVE ${appt.id}\n\n`;
                });
            }
            
            message += `━━━━━━━━━━━━━━━━━━━━━\n`;
            message += `Total: ${appointments.rows.length} appointments`;
            
            return {
                success: true,
                message: message
            };
            
        } catch (error) {
            console.error('Error fetching today\'s appointments:', error.message);
            return {
                success: false,
                message: '❌ Error fetching schedule. Please try again.'
            };
        }
    }
    
    /**
     * Show PENDING approvals
     */
    static async handlePending(doctorInfo, fromNumber) {
        try {
            const appointments = await db.query(
                `SELECT a.*, c.name as customer_name
                 FROM appointments a
                 LEFT JOIN customers c ON a.customer_id = c.id
                 WHERE a.clinic_id = $1 
                 AND a.status = 'pending'
                 AND a.appointment_date >= CURRENT_DATE
                 ORDER BY a.appointment_date, a.appointment_slot
                 LIMIT 20`,
                [doctorInfo.id]
            );
            
            if (appointments.rows.length === 0) {
                return {
                    success: true,
                    message: `✨ *No Pending Approvals*\n\nAll caught up! 🎉`
                };
            }
            
            let message = `⏳ *Pending Approvals (${appointments.rows.length})*\n`;
            message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
            
            appointments.rows.forEach((appt, index) => {
                const date = new Date(appt.appointment_date).toLocaleDateString('en-IN', {
                    day: '2-digit',
                    month: 'short'
                });
                
                message += `${index + 1}. 📋 #${appt.id}\n`;
                message += `   👤 ${appt.patient_name}\n`;
                message += `   📞 ${appt.patient_phone}\n`;
                message += `   📅 ${date} | 🕒 ${appt.appointment_slot}\n`;
                message += `   ✅ APPROVE ${appt.id} | ❌ REJECT ${appt.id}\n\n`;
            });
            
            message += `━━━━━━━━━━━━━━━━━━━━━\n`;
            message += `Reply with command to take action.`;
            
            return {
                success: true,
                message: message
            };
            
        } catch (error) {
            console.error('Error fetching pending appointments:', error.message);
            return {
                success: false,
                message: '❌ Error fetching pending approvals. Please try again.'
            };
        }
    }
    
    /**
     * Show TOMORROW's appointments
     */
    static async handleTomorrow(doctorInfo, fromNumber) {
        try {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const tomorrowDate = tomorrow.toISOString().split('T')[0];
            
            const appointments = await db.query(
                `SELECT a.*, c.name as customer_name
                 FROM appointments a
                 LEFT JOIN customers c ON a.customer_id = c.id
                 WHERE a.clinic_id = $1 
                 AND a.appointment_date = $2
                 AND a.status IN ('pending', 'confirmed')
                 ORDER BY a.appointment_slot`,
                [doctorInfo.id, tomorrowDate]
            );
            
            if (appointments.rows.length === 0) {
                return {
                    success: true,
                    message: `📅 *Tomorrow's Schedule*\n\n✨ No appointments tomorrow!`
                };
            }
            
            let message = `📅 *Tomorrow's Schedule*\n`;
            message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
            
            appointments.rows.forEach((appt, index) => {
                const statusIcon = appt.status === 'confirmed' ? '✅' : '⏳';
                message += `${index + 1}. ${statusIcon} ${appt.appointment_slot}\n`;
                message += `   👤 ${appt.patient_name} (#${appt.id})\n`;
                message += `   📞 ${appt.patient_phone}\n\n`;
            });
            
            message += `━━━━━━━━━━━━━━━━━━━━━\n`;
            message += `Total: ${appointments.rows.length} appointments`;
            
            return {
                success: true,
                message: message
            };
            
        } catch (error) {
            console.error('Error fetching tomorrow\'s appointments:', error.message);
            return {
                success: false,
                message: '❌ Error fetching schedule. Please try again.'
            };
        }
    }
    
    /**
     * Show STATISTICS
     */
    static async handleStats(doctorInfo, fromNumber) {
        try {
            const stats = await db.query(
                `SELECT 
                    COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
                    COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed_count,
                    COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
                    COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_count,
                    COUNT(*) FILTER (WHERE status = 'rejected') as rejected_count,
                    COUNT(*) FILTER (WHERE appointment_date = CURRENT_DATE) as today_count,
                    COUNT(*) FILTER (WHERE appointment_date = CURRENT_DATE + INTERVAL '1 day') as tomorrow_count,
                    COUNT(*) FILTER (WHERE appointment_date >= CURRENT_DATE) as upcoming_count
                 FROM appointments
                 WHERE clinic_id = $1`,
                [doctorInfo.id]
            );
            
            const s = stats.rows[0];
            
            let message = `📊 *Clinic Statistics*\n`;
            message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
            message += `⏳ Pending Approval: ${s.pending_count}\n`;
            message += `✅ Confirmed: ${s.confirmed_count}\n`;
            message += `✔️ Completed: ${s.completed_count}\n`;
            message += `❌ Cancelled: ${s.cancelled_count}\n`;
            message += `🚫 Rejected: ${s.rejected_count}\n\n`;
            message += `📅 Today: ${s.today_count} appointments\n`;
            message += `📅 Tomorrow: ${s.tomorrow_count} appointments\n`;
            message += `📅 Upcoming: ${s.upcoming_count} appointments\n\n`;
            message += `━━━━━━━━━━━━━━━━━━━━━`;
            
            return {
                success: true,
                message: message
            };
            
        } catch (error) {
            console.error('Error fetching stats:', error.message);
            return {
                success: false,
                message: '❌ Error fetching statistics. Please try again.'
            };
        }
    }
    
    /**
     * Show HELP/Commands
     */
    static async handleHelp(doctorInfo, fromNumber) {
        const message = `🩺 *Doctor Commands*\n`;
        const helpMessage = `━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `📋 *Appointment Management:*\n` +
            `• APPROVE [ID] - Approve appointment\n` +
            `• REJECT [ID] - Reject appointment\n` +
            `• PENDING - View pending approvals\n\n` +
            `📅 *Schedule:*\n` +
            `• TODAY - Today's appointments\n` +
            `• TOMORROW - Tomorrow's schedule\n\n` +
            `📊 *Analytics:*\n` +
            `• STATS - View statistics\n\n` +
            `❓ *Help:*\n` +
            `• HELP - Show this message\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `Example: APPROVE 12`;
        
        return {
            success: true,
            message: message + helpMessage
        };
    }
    
    /**
     * Invalid command handler
     */
    static async handleInvalidCommand(doctorInfo, fromNumber) {
        return {
            success: false,
            message: `❓ *Invalid Command*\n\nReply "HELP" to see available commands.\n\nCommon commands:\n• PENDING\n• TODAY\n• APPROVE [ID]\n• REJECT [ID]`
        };
    }
    
    /**
     * Notify patient about approval
     */
    static async notifyPatientApproval(appointment, doctorInfo) {
        try {
            const date = new Date(appointment.appointment_date).toLocaleDateString('en-IN', {
                day: '2-digit',
                month: 'long',
                year: 'numeric'
            });
            
            const message = `✅ *Appointment Confirmed!*\n\n` +
                `📋 Booking ID: #${appointment.id}\n` +
                `👨‍⚕️ Doctor: ${doctorInfo.doctor_name}\n` +
                `📅 Date: ${date}\n` +
                `🕒 Time: ${appointment.appointment_slot}\n` +
                `📍 ${doctorInfo.name}\n\n` +
                `Your appointment has been approved!\n` +
                `See you at the clinic! 🏥\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n` +
                `Need to cancel? Reply: CANCEL ${appointment.id}`;
            
            await sendWhatsAppMessage(appointment.patient_phone, message);
            
            console.log(`✅ Approval notification sent to ${appointment.patient_phone}`);
            
        } catch (error) {
            console.error('Error notifying patient approval:', error.message);
        }
    }
    
    /**
     * Notify patient about rejection
     */
    static async notifyPatientRejection(appointment, doctorInfo) {
        try {
            const message = `⚠️ *Appointment Not Available*\n\n` +
                `📋 Booking ID: #${appointment.id}\n` +
                `📅 Requested Date: ${new Date(appointment.appointment_date).toLocaleDateString('en-IN')}\n` +
                `🕒 Requested Time: ${appointment.appointment_slot}\n\n` +
                `Unfortunately, this slot is no longer available.\n\n` +
                `📱 *Rebook Now:*\n` +
                `Reply "1" to see available slots\n\n` +
                `We apologize for the inconvenience! 🙏`;
            
            await sendWhatsAppMessage(appointment.patient_phone, message);
            
            console.log(`✅ Rejection notification sent to ${appointment.patient_phone}`);
            
        } catch (error) {
            console.error('Error notifying patient rejection:', error.message);
        }
    }
    
    /**
     * Notify doctor about new appointment
     */
    static async notifyDoctorNewAppointment(appointment, doctorInfo) {
        try {
            const date = new Date(appointment.appointment_date).toLocaleDateString('en-IN', {
                day: '2-digit',
                month: 'long',
                year: 'numeric'
            });
            
            const message = `🔔 *New Appointment Request*\n\n` +
                `📋 Request ID: #${appointment.id}\n` +
                `👤 Patient: ${appointment.patient_name}\n` +
                `📞 Phone: ${appointment.patient_phone}\n` +
                `📅 Date: ${date}\n` +
                `🕒 Time: ${appointment.appointment_slot}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n` +
                `⏳ *Status:* Pending Your Approval\n\n` +
                `✅ To approve: Reply *APPROVE ${appointment.id}*\n` +
                `❌ To reject: Reply *REJECT ${appointment.id}*\n\n` +
                `View all pending: Reply *PENDING*`;
            
            // Send to doctor's WhatsApp
            const doctorPhone = doctorInfo.doctor_whatsapp.replace('whatsapp:', '');
            await sendWhatsAppMessage(doctorPhone, message);
            
            // Update notification status
            await db.query(
                `UPDATE appointments 
                 SET doctor_notified = true, doctor_notified_at = NOW()
                 WHERE id = $1`,
                [appointment.id]
            );
            
            console.log(`✅ Doctor notification sent for appointment #${appointment.id}`);
            
            return true;
            
        } catch (error) {
            console.error('Error notifying doctor:', error.message);
            return false;
        }
    }
    
    /**
     * Log doctor action
     */
    static async logDoctorAction(doctorId, doctorPhone, commandText, appointmentId = null, actionTaken = null) {
        try {
            await db.query(
                `INSERT INTO doctor_actions 
                 (doctor_id, doctor_phone, command_type, appointment_id, command_text, action_taken, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [doctorId, doctorPhone, commandText.split(' ')[0], appointmentId, commandText, actionTaken]
            );
        } catch (error) {
            console.error('Error logging doctor action:', error.message);
        }
    }
}

module.exports = DoctorCommandsHandler;

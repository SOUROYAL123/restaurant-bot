/**
 * ═══════════════════════════════════════════════════════════
 * DOCTOR SELECTION HANDLER
 * Handle multi-doctor clinic selection
 * ═══════════════════════════════════════════════════════════
 */

const db = require('../config/database');

class DoctorSelection {
    
    /**
     * Check if clinic has multiple doctors
     */
    static async hasMultipleDoctors(clinicId) {
        try {
            const result = await db.query(
                `SELECT COUNT(*) as count 
                 FROM doctors 
                 WHERE clinic_id = $1 AND status = 'active'`,
                [clinicId]
            );
            
            return parseInt(result.rows[0].count) > 1;
            
        } catch (error) {
            console.error('Error checking multiple doctors:', error.message);
            return false;
        }
    }
    
    /**
     * Get all active doctors for a clinic
     */
    static async getDoctors(clinicId) {
        try {
            const result = await db.query(
                `SELECT id, name, specialization, qualification, 
                        consultation_fee, available_days, available_hours, 
                        years_experience, rating, total_patients
                 FROM doctors 
                 WHERE clinic_id = $1 AND status = 'active'
                 ORDER BY name`,
                [clinicId]
            );
            
            return result.rows;
            
        } catch (error) {
            console.error('Error getting doctors:', error.message);
            return [];
        }
    }
    
    /**
     * Get doctor by ID
     */
    static async getDoctorById(doctorId) {
        try {
            const result = await db.query(
                `SELECT * FROM doctors WHERE id = $1 AND status = 'active' LIMIT 1`,
                [doctorId]
            );
            
            return result.rows.length > 0 ? result.rows[0] : null;
            
        } catch (error) {
            console.error('Error getting doctor:', error.message);
            return null;
        }
    }
    
    /**
     * Get default doctor for clinic
     */
    static async getDefaultDoctor(clinicId) {
        try {
            const result = await db.query(
                `SELECT id FROM doctors 
                 WHERE clinic_id = $1 AND status = 'active'
                 ORDER BY total_patients DESC, name 
                 LIMIT 1`,
                [clinicId]
            );
            
            return result.rows.length > 0 ? result.rows[0].id : null;
            
        } catch (error) {
            console.error('Error getting default doctor:', error.message);
            return null;
        }
    }
    
    /**
     * Show doctor selection menu
     */
    static async showDoctorMenu(clinicId) {
        try {
            const doctors = await this.getDoctors(clinicId);
            
            if (doctors.length === 0) {
                return {
                    success: false,
                    message: '❌ No doctors available at the moment. Please try again later.'
                };
            }
            
            if (doctors.length === 1) {
                // Single doctor - auto-select
                return {
                    success: true,
                    autoSelect: true,
                    doctorId: doctors[0].id,
                    message: null
                };
            }
            
            // Multiple doctors - show selection menu
            let message = `👨‍⚕️ *Select Your Doctor*\n\n`;
            message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
            
            doctors.forEach((doctor, index) => {
                message += `*${index + 1}. Dr. ${doctor.name}*\n`;
                message += `   🩺 ${doctor.specialization}\n`;
                
                if (doctor.qualification) {
                    message += `   🎓 ${doctor.qualification}\n`;
                }
                
                if (doctor.years_experience) {
                    message += `   📅 ${doctor.years_experience} years experience\n`;
                }
                
                if (doctor.consultation_fee && doctor.consultation_fee > 0) {
                    message += `   💰 ₹${doctor.consultation_fee} consultation\n`;
                }
                
                if (doctor.rating && doctor.rating > 0) {
                    message += `   ⭐ ${doctor.rating}/5.0 rating\n`;
                }
                
                if (doctor.available_days) {
                    message += `   📅 Available: ${doctor.available_days}\n`;
                }
                
                message += `\n`;
            });
            
            message += `━━━━━━━━━━━━━━━━━━━━━\n`;
            message += `\nReply with number (1-${doctors.length})`;
            
            return {
                success: true,
                autoSelect: false,
                message: message,
                doctors: doctors,
                nextStage: 'select_doctor'
            };
            
        } catch (error) {
            console.error('Error showing doctor menu:', error.message);
            return {
                success: false,
                message: '❌ Error loading doctors. Please try again.'
            };
        }
    }
    
    /**
     * Handle doctor selection
     */
    static async handleDoctorSelection(clinicId, selection, doctors) {
        try {
            const selectedIndex = parseInt(selection) - 1;
            
            if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= doctors.length) {
                return {
                    success: false,
                    message: `❌ Invalid selection. Please reply with a number between 1 and ${doctors.length}.`
                };
            }
            
            const selectedDoctor = doctors[selectedIndex];
            
            const message = `✅ *Doctor Selected*\n\n` +
                `👨‍⚕️ Dr. ${selectedDoctor.name}\n` +
                `🩺 ${selectedDoctor.specialization}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `👤 *What is your name?*`;
            
            return {
                success: true,
                message: message,
                doctorId: selectedDoctor.id,
                doctorName: selectedDoctor.name,
                nextStage: 'booking_name'
            };
            
        } catch (error) {
            console.error('Error handling doctor selection:', error.message);
            return {
                success: false,
                message: '❌ Error selecting doctor. Please try again.'
            };
        }
    }
    
    /**
     * Get doctor's available slots for a date
     */
    static async getDoctorAvailableSlots(doctorId, date) {
        try {
            const doctor = await this.getDoctorById(doctorId);
            if (!doctor) return [];
            
            const dayOfWeek = new Date(date).getDay(); // 0-6
            
            // Check if doctor is available on this day
            const availability = await db.query(
                `SELECT * FROM doctor_availability 
                 WHERE doctor_id = $1 AND day_of_week = $2
                 ORDER BY start_time`,
                [doctorId, dayOfWeek]
            );
            
            if (availability.rows.length === 0) {
                // Use default hours from doctor
                return await this.generateDefaultSlots(doctor);
            }
            
            // Generate slots from availability
            const slots = [];
            for (const avail of availability.rows) {
                const slotDuration = avail.slot_duration_minutes || 30;
                const generatedSlots = this.generateTimeSlots(
                    avail.start_time, 
                    avail.end_time, 
                    slotDuration
                );
                slots.push(...generatedSlots);
            }
            
            // Get booked slots
            const booked = await db.query(
                `SELECT appointment_slot 
                 FROM appointments 
                 WHERE doctor_id = $1 
                 AND appointment_date = $2
                 AND status IN ('pending', 'confirmed')`,
                [doctorId, date]
            );
            
            const bookedSlots = booked.rows.map(row => row.appointment_slot);
            
            // Filter out booked
            return slots.filter(slot => !bookedSlots.includes(slot));
            
        } catch (error) {
            console.error('Error getting doctor slots:', error.message);
            return [];
        }
    }
    
    /**
     * Generate default slots from doctor's available hours
     */
    static async generateDefaultSlots(doctor) {
        if (!doctor.available_hours) return [];
        
        // Parse "09:00 AM - 06:00 PM"
        const match = doctor.available_hours.match(/(\d{2}:\d{2}\s*[AP]M)\s*-\s*(\d{2}:\d{2}\s*[AP]M)/i);
        if (!match) return [];
        
        return this.generateTimeSlots(match[1], match[2], 30);
    }
    
    /**
     * Generate time slots
     */
    static generateTimeSlots(startTime, endTime, intervalMinutes = 30) {
        const slots = [];
        
        // Parse times (simplified version)
        const start = this.parseTimeToMinutes(startTime);
        const end = this.parseTimeToMinutes(endTime);
        
        let current = start;
        while (current < end) {
            slots.push(this.minutesToTimeString(current));
            current += intervalMinutes;
        }
        
        return slots;
    }
    
    /**
     * Parse time to minutes
     */
    static parseTimeToMinutes(timeStr) {
        const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (!match) return 0;
        
        let hours = parseInt(match[1]);
        const minutes = parseInt(match[2]);
        const period = match[3].toUpperCase();
        
        if (period === 'PM' && hours !== 12) hours += 12;
        if (period === 'AM' && hours === 12) hours = 0;
        
        return hours * 60 + minutes;
    }
    
    /**
     * Convert minutes to time string
     */
    static minutesToTimeString(totalMinutes) {
        let hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        
        const period = hours >= 12 ? 'PM' : 'AM';
        if (hours > 12) hours -= 12;
        if (hours === 0) hours = 12;
        
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${period}`;
    }
    
    /**
     * Get doctor statistics
     */
    static async getDoctorStats(doctorId) {
        try {
            const stats = await db.query(
                `SELECT 
                    COUNT(*) FILTER (WHERE status = 'completed') as completed,
                    COUNT(*) FILTER (WHERE status = 'pending') as pending,
                    COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed,
                    AVG(feedback_rating) FILTER (WHERE feedback_rating > 0) as avg_rating
                 FROM appointments 
                 WHERE doctor_id = $1`,
                [doctorId]
            );
            
            return stats.rows[0];
            
        } catch (error) {
            console.error('Error getting doctor stats:', error.message);
            return null;
        }
    }
}

module.exports = DoctorSelection;

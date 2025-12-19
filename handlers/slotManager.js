/**
 * ═══════════════════════════════════════════════════════════
 * SLOT MANAGER
 * Smart slot suggestions based on availability
 * ═══════════════════════════════════════════════════════════
 */

const db = require('../config/database');

class SlotManager {
    
    /**
     * Get available slots for a date
     */
    static async getAvailableSlots(clinicId, date, doctorId = null) {
        try {
            // Get clinic business hours
            const clinic = await db.query(
                `SELECT business_hours_start, business_hours_end 
                 FROM clinics WHERE id = $1`,
                [clinicId]
            );
            
            if (clinic.rows.length === 0) {
                return [];
            }
            
            const startTime = clinic.rows[0].business_hours_start || '09:00 AM';
            const endTime = clinic.rows[0].business_hours_end || '06:00 PM';
            
            // Generate all possible slots
            const allSlots = this.generateTimeSlots(startTime, endTime, 30); // 30-min intervals
            
            // Get booked slots
            let bookedQuery = `
                SELECT appointment_slot 
                FROM appointments 
                WHERE clinic_id = $1 
                AND appointment_date = $2
                AND status IN ('pending', 'confirmed')
            `;
            
            const params = [clinicId, date];
            
            if (doctorId) {
                bookedQuery += ` AND doctor_id = $3`;
                params.push(doctorId);
            }
            
            const booked = await db.query(bookedQuery, params);
            const bookedSlots = booked.rows.map(row => row.appointment_slot);
            
            // Filter out booked slots
            const availableSlots = allSlots.filter(slot => !bookedSlots.includes(slot));
            
            return availableSlots;
            
        } catch (error) {
            console.error('Error getting available slots:', error.message);
            return [];
        }
    }
    
    /**
     * Generate time slots between start and end time
     */
    static generateTimeSlots(startTime, endTime, intervalMinutes = 30) {
        const slots = [];
        
        // Parse start time
        let [startHour, startMinute, startPeriod] = this.parseTime(startTime);
        let [endHour, endMinute, endPeriod] = this.parseTime(endTime);
        
        // Convert to 24-hour format
        if (startPeriod === 'PM' && startHour !== 12) startHour += 12;
        if (startPeriod === 'AM' && startHour === 12) startHour = 0;
        if (endPeriod === 'PM' && endHour !== 12) endHour += 12;
        if (endPeriod === 'AM' && endHour === 12) endHour = 0;
        
        // Generate slots
        let currentHour = startHour;
        let currentMinute = startMinute;
        
        while (currentHour < endHour || (currentHour === endHour && currentMinute < endMinute)) {
            // Convert back to 12-hour format
            let displayHour = currentHour;
            let period = 'AM';
            
            if (currentHour === 0) {
                displayHour = 12;
            } else if (currentHour === 12) {
                period = 'PM';
            } else if (currentHour > 12) {
                displayHour = currentHour - 12;
                period = 'PM';
            }
            
            const formattedTime = `${String(displayHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')} ${period}`;
            slots.push(formattedTime);
            
            // Add interval
            currentMinute += intervalMinutes;
            if (currentMinute >= 60) {
                currentMinute -= 60;
                currentHour += 1;
            }
        }
        
        return slots;
    }
    
    /**
     * Parse time string
     */
    static parseTime(timeStr) {
        const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (!match) return [9, 0, 'AM']; // Default
        
        return [
            parseInt(match[1]),
            parseInt(match[2]),
            match[3].toUpperCase()
        ];
    }
    
    /**
     * Suggest best slots (morning, afternoon, evening)
     */
    static async suggestSlots(clinicId, date, doctorId = null) {
        try {
            const availableSlots = await this.getAvailableSlots(clinicId, date, doctorId);
            
            if (availableSlots.length === 0) {
                return {
                    morning: [],
                    afternoon: [],
                    evening: [],
                    all: []
                };
            }
            
            const morning = [];
            const afternoon = [];
            const evening = [];
            
            availableSlots.forEach(slot => {
                const hour = this.getHourFrom12HourFormat(slot);
                
                if (hour < 12) {
                    morning.push(slot);
                } else if (hour < 17) {
                    afternoon.push(slot);
                } else {
                    evening.push(slot);
                }
            });
            
            return {
                morning: morning.slice(0, 3),
                afternoon: afternoon.slice(0, 3),
                evening: evening.slice(0, 3),
                all: availableSlots
            };
            
        } catch (error) {
            console.error('Error suggesting slots:', error.message);
            return {
                morning: [],
                afternoon: [],
                evening: [],
                all: []
            };
        }
    }
    
    /**
     * Get hour in 24-hour format from 12-hour format
     */
    static getHourFrom12HourFormat(timeStr) {
        const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (!match) return 0;
        
        let hour = parseInt(match[1]);
        const period = match[3].toUpperCase();
        
        if (period === 'PM' && hour !== 12) hour += 12;
        if (period === 'AM' && hour === 12) hour = 0;
        
        return hour;
    }
    
    /**
     * Format available slots as message
     */
    static formatSlotsMessage(slots, date) {
        const displayDate = new Date(date).toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'long',
            weekday: 'long'
        });
        
        let message = `📅 *Available Slots*\n${displayDate}\n\n`;
        
        if (slots.all.length === 0) {
            message += `❌ No slots available on this date.\n\nPlease choose a different date.`;
            return message;
        }
        
        if (slots.morning.length > 0) {
            message += `🌅 *Morning:*\n`;
            slots.morning.forEach((slot, i) => {
                message += `${i + 1}. ${slot}\n`;
            });
            message += '\n';
        }
        
        if (slots.afternoon.length > 0) {
            message += `☀️ *Afternoon:*\n`;
            slots.afternoon.forEach((slot, i) => {
                message += `${i + 1}. ${slot}\n`;
            });
            message += '\n';
        }
        
        if (slots.evening.length > 0) {
            message += `🌆 *Evening:*\n`;
            slots.evening.forEach((slot, i) => {
                message += `${i + 1}. ${slot}\n`;
            });
            message += '\n';
        }
        
        message += `━━━━━━━━━━━━━━━━━━━━━\n`;
        message += `Reply with time to book\n`;
        message += `Example: 10:00 AM`;
        
        return message;
    }
}

module.exports = SlotManager;

/**
 * ═══════════════════════════════════════════════════════════
 * RECURRING APPOINTMENTS
 * Weekly/Monthly appointment management
 * ═══════════════════════════════════════════════════════════
 */

const db = require('../config/database');
const { sendWhatsAppMessage } = require('../utils/twilioClient');

class RecurringAppointments {
    
    /**
     * Initialize recurring appointments table
     */
    static async initializeTable() {
        const query = `
            CREATE TABLE IF NOT EXISTS recurring_appointments (
                id SERIAL PRIMARY KEY,
                clinic_id INTEGER REFERENCES clinics(id),
                customer_id INTEGER REFERENCES customers(id),
                patient_name VARCHAR(100) NOT NULL,
                patient_phone VARCHAR(20) NOT NULL,
                appointment_slot VARCHAR(20) NOT NULL,
                day_of_week INTEGER,
                day_of_month INTEGER,
                recurrence_type VARCHAR(20) NOT NULL,
                start_date DATE NOT NULL,
                end_date DATE,
                status VARCHAR(20) DEFAULT 'active',
                last_generated_date DATE,
                created_at TIMESTAMP DEFAULT NOW(),
                CHECK (recurrence_type IN ('weekly', 'monthly'))
            );
            
            CREATE INDEX IF NOT EXISTS idx_recurring_clinic ON recurring_appointments(clinic_id);
            CREATE INDEX IF NOT EXISTS idx_recurring_customer ON recurring_appointments(customer_id);
        `;
        
        await db.query(query);
    }
    
    /**
     * Create recurring appointment series
     */
    static async create(clinicId, customerId, patientName, patientPhone, appointmentSlot, recurrenceType, dayValue, startDate, endDate = null) {
        try {
            let dayOfWeek = null;
            let dayOfMonth = null;
            
            if (recurrenceType === 'weekly') {
                dayOfWeek = dayValue; // 0-6 (Sunday-Saturday)
            } else if (recurrenceType === 'monthly') {
                dayOfMonth = dayValue; // 1-31
            }
            
            const result = await db.query(
                `INSERT INTO recurring_appointments 
                 (clinic_id, customer_id, patient_name, patient_phone, 
                  appointment_slot, day_of_week, day_of_month, 
                  recurrence_type, start_date, end_date, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')
                 RETURNING id`,
                [clinicId, customerId, patientName, patientPhone, appointmentSlot, 
                 dayOfWeek, dayOfMonth, recurrenceType, startDate, endDate]
            );
            
            return {
                success: true,
                recurringId: result.rows[0].id
            };
            
        } catch (error) {
            console.error('Error creating recurring appointment:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Generate upcoming recurring appointments
     * Run this daily via cron
     */
    static async generateUpcoming(daysAhead = 30) {
        try {
            const endDate = new Date();
            endDate.setDate(endDate.getDate() + daysAhead);
            
            // Get all active recurring appointments
            const recurring = await db.query(
                `SELECT * FROM recurring_appointments 
                 WHERE status = 'active'
                 AND (end_date IS NULL OR end_date >= CURRENT_DATE)`
            );
            
            for (const recur of recurring.rows) {
                if (recur.recurrence_type === 'weekly') {
                    await this.generateWeeklyAppointments(recur, daysAhead);
                } else if (recur.recurrence_type === 'monthly') {
                    await this.generateMonthlyAppointments(recur, daysAhead);
                }
            }
            
            console.log(`✅ Generated recurring appointments for next ${daysAhead} days`);
            
        } catch (error) {
            console.error('Error generating recurring appointments:', error.message);
        }
    }
    
    /**
     * Generate weekly recurring appointments
     */
    static async generateWeeklyAppointments(recur, daysAhead) {
        try {
            const today = new Date();
            const endDate = new Date();
            endDate.setDate(endDate.getDate() + daysAhead);
            
            let currentDate = new Date(today);
            
            while (currentDate <= endDate) {
                if (currentDate.getDay() === recur.day_of_week && currentDate >= new Date(recur.start_date)) {
                    const dateStr = currentDate.toISOString().split('T')[0];
                    
                    // Check if already created
                    const exists = await db.query(
                        `SELECT id FROM appointments 
                         WHERE clinic_id = $1 
                         AND customer_id = $2 
                         AND appointment_date = $3 
                         AND appointment_slot = $4`,
                        [recur.clinic_id, recur.customer_id, dateStr, recur.appointment_slot]
                    );
                    
                    if (exists.rows.length === 0) {
                        // Create appointment
                        await db.query(
                            `INSERT INTO appointments 
                             (clinic_id, customer_id, patient_name, patient_phone, 
                              appointment_date, appointment_slot, status, booked_at, created_at)
                             VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW(), NOW())`,
                            [recur.clinic_id, recur.customer_id, recur.patient_name, 
                             recur.patient_phone, dateStr, recur.appointment_slot]
                        );
                        
                        console.log(`✅ Created weekly recurring appointment for ${dateStr}`);
                    }
                }
                
                currentDate.setDate(currentDate.getDate() + 1);
            }
            
            // Update last generated date
            await db.query(
                `UPDATE recurring_appointments 
                 SET last_generated_date = CURRENT_DATE 
                 WHERE id = $1`,
                [recur.id]
            );
            
        } catch (error) {
            console.error('Error generating weekly appointments:', error.message);
        }
    }
    
    /**
     * Generate monthly recurring appointments
     */
    static async generateMonthlyAppointments(recur, daysAhead) {
        try {
            const today = new Date();
            const endDate = new Date();
            endDate.setDate(endDate.getDate() + daysAhead);
            
            let currentDate = new Date(today);
            currentDate.setDate(1); // Start from 1st of month
            
            while (currentDate <= endDate) {
                currentDate.setDate(recur.day_of_month);
                
                if (currentDate >= today && currentDate >= new Date(recur.start_date) && currentDate <= endDate) {
                    const dateStr = currentDate.toISOString().split('T')[0];
                    
                    // Check if already created
                    const exists = await db.query(
                        `SELECT id FROM appointments 
                         WHERE clinic_id = $1 
                         AND customer_id = $2 
                         AND appointment_date = $3 
                         AND appointment_slot = $4`,
                        [recur.clinic_id, recur.customer_id, dateStr, recur.appointment_slot]
                    );
                    
                    if (exists.rows.length === 0) {
                        // Create appointment
                        await db.query(
                            `INSERT INTO appointments 
                             (clinic_id, customer_id, patient_name, patient_phone, 
                              appointment_date, appointment_slot, status, booked_at, created_at)
                             VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW(), NOW())`,
                            [recur.clinic_id, recur.customer_id, recur.patient_name, 
                             recur.patient_phone, dateStr, recur.appointment_slot]
                        );
                        
                        console.log(`✅ Created monthly recurring appointment for ${dateStr}`);
                    }
                }
                
                // Move to next month
                currentDate.setMonth(currentDate.getMonth() + 1);
                currentDate.setDate(1);
            }
            
            // Update last generated date
            await db.query(
                `UPDATE recurring_appointments 
                 SET last_generated_date = CURRENT_DATE 
                 WHERE id = $1`,
                [recur.id]
            );
            
        } catch (error) {
            console.error('Error generating monthly appointments:', error.message);
        }
    }
    
    /**
     * Cancel recurring series
     */
    static async cancel(recurringId) {
        try {
            await db.query(
                `UPDATE recurring_appointments 
                 SET status = 'cancelled'
                 WHERE id = $1`,
                [recurringId]
            );
            
            return { success: true };
            
        } catch (error) {
            console.error('Error cancelling recurring appointment:', error.message);
            return { success: false, error: error.message };
        }
    }
}

// Initialize table on load
RecurringAppointments.initializeTable().catch(console.error);

module.exports = RecurringAppointments;

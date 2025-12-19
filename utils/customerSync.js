const db = require('../config/database');

/**
 * Sync customer data - create or update customer record
 */
async function syncCustomer(phoneNumber, clinicId, customerData = {}) {
    try {
        const { name, languagePreference } = customerData;
        
        const result = await db.query(
            `INSERT INTO customers (phone, clinic_id, name, preferred_language, last_contact_date, first_contact_date)
             VALUES ($1, $2, $3, $4, NOW(), NOW())
             ON CONFLICT (phone, clinic_id) 
             DO UPDATE SET 
                name = COALESCE($3, customers.name),
                preferred_language = COALESCE($4, customers.preferred_language),
                last_contact_date = NOW(),
                updated_at = NOW()
             RETURNING *`,
            [phoneNumber, clinicId, name, languagePreference]
        );
        
        return result.rows[0];
    } catch (error) {
        console.error('❌ Customer sync error:', error.message);
        return null;
    }
}

/**
 * Get customer by phone and clinic
 */
async function getCustomer(phoneNumber, clinicId) {
    try {
        const result = await db.query(
            `SELECT * FROM customers 
             WHERE phone = $1 AND clinic_id = $2`,
            [phoneNumber, clinicId]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ Get customer error:', error.message);
        return null;
    }
}

/**
 * Update customer appointment count
 */
async function incrementAppointments(phoneNumber, clinicId) {
    try {
        await db.query(
            `UPDATE customers 
             SET total_appointments = total_appointments + 1,
                 updated_at = NOW()
             WHERE phone = $1 AND clinic_id = $2`,
            [phoneNumber, clinicId]
        );
    } catch (error) {
        console.error('❌ Increment appointments error:', error.message);
    }
}

/**
 * Log customer interaction
 */
async function logInteraction(phoneNumber, clinicId, messageType, messageContent, botResponse) {
    try {
        await db.query(
            `INSERT INTO customer_interactions 
             (customer_phone, clinic_id, message_type, message_content, bot_response)
             VALUES ($1, $2, $3, $4, $5)`,
            [phoneNumber, clinicId, messageType, messageContent, botResponse]
        );
    } catch (error) {
        console.error('❌ Log interaction error:', error.message);
    }
}

/**
 * Get customer interaction history
 */
async function getCustomerHistory(phoneNumber, clinicId, limit = 10) {
    try {
        const result = await db.query(
            `SELECT * FROM customer_interactions 
             WHERE customer_phone = $1 AND clinic_id = $2
             ORDER BY created_at DESC
             LIMIT $3`,
            [phoneNumber, clinicId, limit]
        );
        return result.rows;
    } catch (error) {
        console.error('❌ Get customer history error:', error.message);
        return [];
    }
}

/**
 * Get all customers for a clinic
 */
async function getClinicCustomers(clinicId, limit = 100, offset = 0) {
    try {
        const result = await db.query(
            `SELECT * FROM customers 
             WHERE clinic_id = $1
             ORDER BY last_contact_date DESC
             LIMIT $2 OFFSET $3`,
            [clinicId, limit, offset]
        );
        return result.rows;
    } catch (error) {
        console.error('❌ Get clinic customers error:', error.message);
        return [];
    }
}

/**
 * Get customer statistics for a clinic
 */
async function getCustomerStats(clinicId) {
    try {
        const result = await db.query(
            `SELECT 
                COUNT(*) as total_customers,
                COUNT(CASE WHEN last_contact_date > NOW() - INTERVAL '7 days' THEN 1 END) as active_last_week,
                COUNT(CASE WHEN last_contact_date > NOW() - INTERVAL '30 days' THEN 1 END) as active_last_month,
                SUM(total_appointments) as total_appointments,
                AVG(total_appointments) as avg_appointments_per_customer
             FROM customers 
             WHERE clinic_id = $1`,
            [clinicId]
        );
        return result.rows[0];
    } catch (error) {
        console.error('❌ Get customer stats error:', error.message);
        return null;
    }
}

module.exports = {
    syncCustomer,
    getCustomer,
    incrementAppointments,
    logInteraction,
    getCustomerHistory,
    getClinicCustomers,
    getCustomerStats
};

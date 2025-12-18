require('dotenv').config();
const pool = require('./db');

/**
 * CUSTOMER SYNC UTILITY
 * 
 * This script migrates existing appointment data to the new customer-centric schema.
 * It creates customer records from existing appointments and links them properly.
 */

async function syncCustomersFromAppointments() {
    const client = await pool.connect();
    
    try {
        console.log('🔄 Starting customer sync from appointments...\n');
        
        await client.query('BEGIN');
        
        // Step 1: Get all unique customers from appointments
        const appointmentsQuery = `
            SELECT DISTINCT 
                patient_phone,
                patient_name,
                MIN(booked_at) as first_contact,
                MAX(booked_at) as last_contact,
                COUNT(*) as total_bookings
            FROM appointments
            GROUP BY patient_phone, patient_name
        `;
        
        const appointments = await client.query(appointmentsQuery);
        console.log(`📊 Found ${appointments.rows.length} unique customers in appointments\n`);
        
        let created = 0;
        let skipped = 0;
        
        // Step 2: Create customer records
        for (const appt of appointments.rows) {
            try {
                // Normalize phone format
                let phone = appt.patient_phone;
                if (!phone.startsWith('whatsapp:')) {
                    phone = `whatsapp:+${phone.replace(/\D/g, '')}`;
                }
                
                // Insert customer (ignore duplicates)
                const insertResult = await client.query(`
                    INSERT INTO customers (
                        phone, 
                        name, 
                        first_contact_date, 
                        last_contact_date,
                        total_appointments
                    )
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (phone) DO NOTHING
                    RETURNING id
                `, [
                    phone,
                    appt.patient_name,
                    appt.first_contact,
                    appt.last_contact,
                    appt.total_bookings
                ]);
                
                if (insertResult.rows.length > 0) {
                    created++;
                    console.log(`✅ Created customer: ${appt.patient_name} (${phone})`);
                } else {
                    skipped++;
                }
                
            } catch (error) {
                console.error(`❌ Error creating customer ${appt.patient_name}:`, error.message);
            }
        }
        
        console.log(`\n📈 Summary: ${created} created, ${skipped} skipped (already exist)\n`);
        
        // Step 3: Link appointments to customers
        console.log('🔗 Linking appointments to customers...\n');
        
        const linkQuery = `
            UPDATE appointments a
            SET customer_id = c.id
            FROM customers c
            WHERE a.patient_phone = REPLACE(c.phone, 'whatsapp:', '')
              AND a.customer_id IS NULL
        `;
        
        const linkResult = await client.query(linkQuery);
        console.log(`✅ Linked ${linkResult.rowCount} appointments to customers\n`);
        
        // Step 4: Recalculate customer stats
        console.log('📊 Recalculating customer statistics...\n');
        
        const statsQuery = `
            UPDATE customers c
            SET 
                total_appointments = (
                    SELECT COUNT(*) FROM appointments 
                    WHERE customer_id = c.id
                ),
                total_completed = (
                    SELECT COUNT(*) FROM appointments 
                    WHERE customer_id = c.id AND status = 'confirmed'
                ),
                total_cancelled = (
                    SELECT COUNT(*) FROM appointments 
                    WHERE customer_id = c.id AND status = 'cancelled'
                ),
                last_contact_date = (
                    SELECT MAX(booked_at) FROM appointments 
                    WHERE customer_id = c.id
                )
        `;
        
        await client.query(statsQuery);
        console.log('✅ Customer statistics updated\n');
        
        await client.query('COMMIT');
        
        // Step 5: Show summary
        const summary = await client.query(`
            SELECT 
                COUNT(*) as total_customers,
                COUNT(CASE WHEN total_appointments > 0 THEN 1 END) as customers_with_appointments,
                SUM(total_appointments) as total_appointments,
                SUM(total_completed) as total_completed,
                SUM(total_cancelled) as total_cancelled
            FROM customers
        `);
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 FINAL SUMMARY');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`Total Customers: ${summary.rows[0].total_customers}`);
        console.log(`With Appointments: ${summary.rows[0].customers_with_appointments}`);
        console.log(`Total Appointments: ${summary.rows[0].total_appointments}`);
        console.log(`Completed: ${summary.rows[0].total_completed}`);
        console.log(`Cancelled: ${summary.rows[0].total_cancelled}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        
        console.log('✅ Customer sync completed successfully!\n');
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Sync failed:', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Create customer from new appointment booking
 */
async function createOrUpdateCustomer(patientName, patientPhone, preferredLanguage = 'en') {
    try {
        // Normalize phone
        let phone = patientPhone;
        if (!phone.startsWith('whatsapp:')) {
            phone = `whatsapp:${phone}`;
        }
        
        const result = await pool.query(`
            INSERT INTO customers (phone, name, preferred_language, last_contact_date)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (phone) 
            DO UPDATE SET 
                name = EXCLUDED.name,
                last_contact_date = NOW(),
                total_appointments = customers.total_appointments + 1
            RETURNING id
        `, [phone, patientName, preferredLanguage]);
        
        return result.rows[0].id;
        
    } catch (error) {
        console.error('❌ Error creating/updating customer:', error);
        throw error;
    }
}

/**
 * Get customer details by phone
 */
async function getCustomerByPhone(phone) {
    try {
        // Try with and without whatsapp: prefix
        const phones = [
            phone,
            phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`,
            phone.replace('whatsapp:', '')
        ];
        
        const result = await pool.query(`
            SELECT * FROM customers 
            WHERE phone = ANY($1)
            LIMIT 1
        `, [phones]);
        
        return result.rows[0] || null;
        
    } catch (error) {
        console.error('❌ Error getting customer:', error);
        throw error;
    }
}

/**
 * Log customer interaction
 */
async function logInteraction(customerId, clinicId, interactionType, messageBody) {
    try {
        await pool.query(`
            INSERT INTO customer_interactions (
                customer_id, 
                clinic_id, 
                interaction_type, 
                message_body
            )
            VALUES ($1, $2, $3, $4)
        `, [customerId, clinicId, interactionType, messageBody]);
        
    } catch (error) {
        console.error('❌ Error logging interaction:', error);
    }
}

// Run sync if executed directly
if (require.main === module) {
    syncCustomersFromAppointments()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error);
            process.exit(1);
        });
}

module.exports = {
    syncCustomersFromAppointments,
    createOrUpdateCustomer,
    getCustomerByPhone,
    logInteraction
};

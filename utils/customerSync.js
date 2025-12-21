// utils/customerSync.js
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

class CustomerSync {
    async syncCustomer(userPhone, clinicId, session) {
        try {
            const name = session.temp_data?.name || `User ${userPhone.slice(-4)}`;

            const result = await sql`
                INSERT INTO customers (whatsapp, clinic_id, name, language)
                VALUES (${userPhone}, ${clinicId}, ${name}, ${session.language || 'en'})
                ON CONFLICT (whatsapp, clinic_id) 
                DO UPDATE SET 
                    name = COALESCE(EXCLUDED.name, customers.name),
                    language = COALESCE(EXCLUDED.language, customers.language),
                    updated_at = NOW()
                RETURNING id
            `;

            return result[0].id;

        } catch (error) {
            console.error('❌ Customer sync error:', error.message);
            return null;
        }
    }

    async getCustomer(userPhone, clinicId) {
        try {
            const customers = await sql`
                SELECT * FROM customers 
                WHERE whatsapp = ${userPhone} 
                AND clinic_id = ${clinicId}
                LIMIT 1
            `;

            return customers.length > 0 ? customers[0] : null;

        } catch (error) {
            console.error('Error getting customer:', error.message);
            return null;
        }
    }

    async updateCustomer(userPhone, clinicId, updates) {
        try {
            const { name, language } = updates;

            await sql`
                UPDATE customers 
                SET 
                    name = COALESCE(${name}, name),
                    language = COALESCE(${language}, language),
                    updated_at = NOW()
                WHERE whatsapp = ${userPhone} 
                AND clinic_id = ${clinicId}
            `;

        } catch (error) {
            console.error('Error updating customer:', error.message);
        }
    }
}

module.exports = new CustomerSync();

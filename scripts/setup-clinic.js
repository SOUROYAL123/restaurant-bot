require('dotenv').config();
const db = require('../config/database');

async function setupClinic() {
    try {
        console.log('🏥 Setting up clinic...');
        
        const wabaNumber = process.env.WABA_NUMBER;
        console.log('WABA Number:', wabaNumber);
        
        // Insert or update clinic
        await db.query(`
            INSERT INTO clinics (
                id, name, doctor_name, doctor_whatsapp,
                address, city, state, status,
                business_hours_start, business_hours_end
            )
            VALUES (
                1, 'Dr Sharma Clinic', 'Dr. Sharma', $1,
                '123 Main Street, Airoli', 'Mumbai', 'Maharashtra', 'active',
                '09:00 AM', '06:00 PM'
            )
            ON CONFLICT (id) 
            DO UPDATE SET 
                doctor_whatsapp = $1,
                updated_at = NOW()
        `, [wabaNumber]);
        
        // Verify
        const result = await db.query(
            'SELECT * FROM clinics WHERE id = 1'
        );
        
        console.log('✅ Clinic setup complete:');
        console.log(result.rows[0]);
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Setup failed:', error.message);
        process.exit(1);
    }
}

setupClinic();

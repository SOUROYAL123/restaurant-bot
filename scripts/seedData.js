require('dotenv').config();
const db = require('../src/config/database');

async function seedData() {
    try {
        console.log('🔄 Seeding test data...');
        
        // Insert test clinic
        await db.query(`
            INSERT INTO clinics (name, whatsapp_number, address, email, phone)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (whatsapp_number) DO NOTHING
        `, [
            'Test Clinic',
            '+14155238886',
            '123 Main St, Kolkata, West Bengal',
            'test@clinic.com',
            '+91-9876543210'
        ]);
        
        console.log('✅ Test data seeded successfully');
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error);
        process.exit(1);
    }
}

seedData();
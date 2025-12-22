// setup-doctor.js
require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function setupDoctor() {
    try {
        console.log('⏳ Setting up doctor...');
        
        // Update clinic table with doctor's WhatsApp
        await sql`
            UPDATE clinics 
            SET doctor_whatsapp = 'whatsapp:+919748006945',
                auto_approve = false
            WHERE id = 1
        `;
        
        console.log('✅ Clinic updated');
        
        // Add doctor to doctors table
        await sql`
            INSERT INTO doctors (name, whatsapp, clinic_id, status)
            VALUES ('Dr. Sharma', 'whatsapp:+919748006945', 1, 'active')
            ON CONFLICT (whatsapp) 
            DO UPDATE SET status = 'active'
        `;
        
        console.log('✅ Doctor added');
        console.log('');
        console.log('✅ SETUP COMPLETE!');
        console.log('Doctor number: +919748006945');
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

setupDoctor();

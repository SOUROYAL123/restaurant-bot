// setup-doctor-complete.js
require('dotenv').config();
const db = require('./db');

async function completeSetup() {
    try {
        console.log('⏳ Starting complete setup...\n');
        
        // Step 1: Fix column size
        console.log('1️⃣ Fixing database column...');
        await db.query(`
            ALTER TABLE doctors 
            ALTER COLUMN whatsapp TYPE VARCHAR(50)
        `);
        console.log('   ✅ Column fixed\n');
        
        // Step 2: Update clinic
        console.log('2️⃣ Updating clinic...');
        await db.query(`
            UPDATE clinics 
            SET doctor_whatsapp = $1,
                auto_approve = false,
                updated_at = NOW()
            WHERE id = 1
        `, ['whatsapp:+919748006945']);
        console.log('   ✅ Clinic updated\n');
        
        // Step 3: Add doctor
        console.log('3️⃣ Adding doctor...');
        await db.query(`
            INSERT INTO doctors (name, whatsapp, clinic_id, specialization, status)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (whatsapp) 
            DO UPDATE SET 
                status = 'active',
                updated_at = NOW()
        `, ['Dr. Sharma', 'whatsapp:+919748006945', 1, 'General Physician', 'active']);
        console.log('   ✅ Doctor added\n');
        
        // Step 4: Verify
        console.log('4️⃣ Verifying setup...');
        const clinic = await db.query(`
            SELECT doctor_whatsapp, auto_approve FROM clinics WHERE id = 1
        `);
        const doctor = await db.query(`
            SELECT name, whatsapp FROM doctors WHERE whatsapp = $1
        `, ['whatsapp:+919748006945']);
        
        console.log('   Clinic doctor_whatsapp:', clinic.rows[0].doctor_whatsapp);
        console.log('   Auto-approve:', clinic.rows[0].auto_approve);
        console.log('   Doctor found:', doctor.rows.length > 0 ? 'Yes ✅' : 'No ❌');
        console.log('');
        
        console.log('🎉 SETUP COMPLETE!\n');
        console.log('📱 Doctor can now send commands from: +919748006945');
        console.log('');
        console.log('Next steps:');
        console.log('1. Run: node send-notification.js');
        console.log('2. Doctor replies: APPROVE #17');
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

completeSetup();

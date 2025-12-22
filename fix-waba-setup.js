// fix-waba-setup.js
require('dotenv').config();
const db = require('./db');

async function fixWabaSetup() {
    try {
        console.log('🔧 Fixing WABA setup...\n');
        
        // 1. Add waba_number column to clinics
        console.log('1️⃣ Adding waba_number column...');
        await db.query(`
            ALTER TABLE clinics 
            ADD COLUMN IF NOT EXISTS waba_number VARCHAR(50)
        `);
        console.log('   ✅ Column added\n');
        
        // 2. Set WABA number for clinic
        console.log('2️⃣ Setting WABA number...');
        await db.query(`
            UPDATE clinics 
            SET waba_number = $1,
                doctor_whatsapp = $2,
                auto_approve = false
            WHERE id = 1
        `, [
            process.env.WABA_NUMBER,           // Bot number
            'whatsapp:+919748006945'            // Doctor's number
        ]);
        console.log('   ✅ WABA number set\n');
        
        // 3. Fix doctors table column size
        console.log('3️⃣ Fixing doctors table...');
        await db.query(`
            ALTER TABLE doctors 
            ALTER COLUMN whatsapp TYPE VARCHAR(50)
        `);
        console.log('   ✅ Column size fixed\n');
        
        // 4. Add doctor
        console.log('4️⃣ Adding doctor...');
        await db.query(`
            INSERT INTO doctors (name, whatsapp, clinic_id, specialization, status)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (whatsapp) 
            DO UPDATE SET 
                status = 'active',
                updated_at = NOW()
        `, ['Dr. Sharma', 'whatsapp:+919748006945', 1, 'General Physician', 'active']);
        console.log('   ✅ Doctor added\n');
        
        // 5. Verify
        console.log('5️⃣ Verifying...');
        const clinic = await db.query(`
            SELECT waba_number, doctor_whatsapp, auto_approve 
            FROM clinics WHERE id = 1
        `);
        
        console.log('\n📊 CONFIGURATION:');
        console.log('   Bot Number (WABA):', clinic.rows[0].waba_number);
        console.log('   Doctor WhatsApp:', clinic.rows[0].doctor_whatsapp);
        console.log('   Auto-approve:', clinic.rows[0].auto_approve);
        console.log('');
        console.log('✅ SETUP COMPLETE!\n');
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

fixWabaSetup();

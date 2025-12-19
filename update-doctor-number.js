/**
 * Quick script to update doctor's number everywhere
 */

require('dotenv').config();
const db = require('./config/database');

async function updateDoctorNumber() {
    try {
        const newNumber = '+919748006945';
        const whatsappNumber = `whatsapp:${newNumber}`;
        
        console.log('🔄 Updating doctor number...');
        
        // Update clinics table
        await db.query(
            `UPDATE clinics 
             SET doctor_whatsapp = $1, updated_at = NOW()
             WHERE id = 1`,
            [whatsappNumber]
        );
        
        console.log('✅ Updated clinics table');
        
        // Update doctors table
        await db.query(
            `UPDATE doctors 
             SET whatsapp_number = $1, updated_at = NOW()
             WHERE clinic_id = 1`,
            [newNumber]
        );
        
        console.log('✅ Updated doctors table');
        
        // Verify
        const clinic = await db.query(
            `SELECT doctor_whatsapp FROM clinics WHERE id = 1`
        );
        
        console.log('✅ Verification:', clinic.rows[0].doctor_whatsapp);
        
        console.log('\n🎉 All done! Doctor number updated to:', newNumber);
        
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

updateDoctorNumber();

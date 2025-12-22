// check-setup.js
require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function checkSetup() {
    console.log('🔍 Checking setup...\n');
    
    // 1. Check clinic configuration
    const clinic = await sql`
        SELECT id, name, doctor_whatsapp, auto_approve 
        FROM clinics 
        WHERE id = 1
    `;
    
    console.log('🏥 CLINIC:');
    console.log('   Name:', clinic[0].name);
    console.log('   Doctor WhatsApp:', clinic[0].doctor_whatsapp);
    console.log('   Auto-approve:', clinic[0].auto_approve ? 'ON ⚠️' : 'OFF ✅');
    console.log('');
    
    // 2. Check doctor exists
    const doctor = await sql`
        SELECT * FROM doctors 
        WHERE whatsapp = 'whatsapp:+919748006945'
    `;
    
    console.log('👨‍⚕️ DOCTOR:');
    if (doctor.length > 0) {
        console.log('   ✅ Found in database');
        console.log('   Name:', doctor[0].name);
        console.log('   Status:', doctor[0].status);
    } else {
        console.log('   ❌ NOT FOUND - Run setup-doctor.js');
    }
    console.log('');
    
    // 3. Check appointment #17
    const apt = await sql`
        SELECT * FROM appointments WHERE id = 17
    `;
    
    console.log('📋 APPOINTMENT #17:');
    if (apt.length > 0) {
        console.log('   Patient:', apt[0].patient_name);
        console.log('   Date:', apt[0].appointment_date);
        console.log('   Time:', apt[0].appointment_time);
        console.log('   Status:', apt[0].status);
    } else {
        console.log('   ❌ Appointment not found');
    }
    console.log('');
    
    // 4. Final check
    if (clinic[0].doctor_whatsapp === 'whatsapp:+919748006945' && doctor.length > 0) {
        console.log('✅ SETUP IS CORRECT!');
        console.log('');
        console.log('📱 Doctor can now send from +919748006945:');
        console.log('   APPROVE #17');
        console.log('   or');
        console.log('   REJECT #17');
    } else {
        console.log('❌ SETUP INCOMPLETE - Please run setup-doctor.js');
    }
    
    process.exit(0);
}

checkSetup();

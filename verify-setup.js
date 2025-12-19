require('dotenv').config();
const db = require('./config/database');

async function verifySetup() {
    console.log('🔍 Verifying Setup...\n');
    
    // Check environment
    console.log('📋 Environment Variables:');
    console.log('WABA_NUMBER:', process.env.WABA_NUMBER);
    console.log('');
    
    // Check database
    const clinic = await db.query(
        `SELECT id, name, doctor_name, doctor_whatsapp FROM clinics WHERE id = 1`
    );
    
    console.log('🏥 Clinic Info:');
    console.log(clinic.rows[0]);
    console.log('');
    
    // Check doctors
    const doctors = await db.query(
        `SELECT id, name, whatsapp_number FROM doctors WHERE clinic_id = 1`
    );
    
    console.log('👨‍⚕️ Doctors:');
    doctors.rows.forEach(doc => console.log(doc));
    console.log('');
    
    // Check recent appointments
    const appointments = await db.query(
        `SELECT COUNT(*) as count FROM appointments WHERE created_at > NOW() - INTERVAL '7 days'`
    );
    
    console.log('📅 Recent Appointments (7 days):', appointments.rows[0].count);
    console.log('');
    
    // Verify match
    const envNumber = process.env.WABA_NUMBER;
    const dbNumber = clinic.rows[0].doctor_whatsapp;
    
    if (envNumber === dbNumber) {
        console.log('✅ Numbers match! Setup is correct.');
    } else {
        console.log('❌ MISMATCH!');
        console.log('   .env:', envNumber);
        console.log('   Database:', dbNumber);
        console.log('   Please fix this discrepancy.');
    }
    
    process.exit(0);
}

verifySetup().catch(console.error);

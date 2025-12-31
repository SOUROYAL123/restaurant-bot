/**
 * Test Script: Verify Doctor Specialization Setup
 * Run this to ensure your database is ready for the enhanced bot
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function runTests() {
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║     DOCTOR SPECIALIZATION SETUP VERIFICATION       ║');
    console.log('╚════════════════════════════════════════════════════╝\n');
    
    let allTestsPassed = true;
    
    try {
        // Test 1: Check active clinics
        console.log('📊 Test 1: Checking active clinics...');
        const clinics = await sql`
            SELECT id, name, doctor_name, doctor_whatsapp 
            FROM clinics 
            WHERE status = 'active'
        `;
        
        if (clinics.length === 0) {
            console.log('❌ FAIL: No active clinics found\n');
            allTestsPassed = false;
        } else {
            console.log(`✅ PASS: Found ${clinics.length} active clinic(s)`);
            clinics.forEach(c => {
                console.log(`   - ${c.name} (Dr. ${c.doctor_name})`);
            });
            console.log('');
        }
        
        // Test 2: Check doctors with specializations
        console.log('📊 Test 2: Checking doctors with specializations...');
        const doctors = await sql`
            SELECT 
                d.id,
                d.name,
                d.specialization,
                d.qualification,
                d.whatsapp,
                d.status,
                c.name as clinic_name
            FROM doctors d
            LEFT JOIN clinics c ON d.clinic_id = c.id
            WHERE d.status = 'active'
            ORDER BY d.specialization, d.name
        `;
        
        if (doctors.length === 0) {
            console.log('❌ FAIL: No active doctors found\n');
            allTestsPassed = false;
        } else {
            const withSpec = doctors.filter(d => d.specialization);
            const withoutSpec = doctors.filter(d => !d.specialization);
            
            console.log(`✅ PASS: Found ${doctors.length} active doctor(s)`);
            console.log(`   - With specialization: ${withSpec.length}`);
            console.log(`   - Without specialization: ${withoutSpec.length}\n`);
            
            if (withoutSpec.length > 0) {
                console.log('⚠️  WARNING: Some doctors missing specialization:');
                withoutSpec.forEach(d => {
                    console.log(`   - Dr. ${d.name} (${d.clinic_name || 'No clinic'})`);
                });
                console.log('');
            }
        }
        
        // Test 3: Group doctors by specialization
        console.log('📊 Test 3: Doctors grouped by specialization...\n');
        
        const grouped = {};
        doctors.forEach(doc => {
            const spec = doc.specialization || 'No Specialization';
            if (!grouped[spec]) grouped[spec] = [];
            grouped[spec].push(doc);
        });
        
        Object.keys(grouped).sort().forEach(spec => {
            console.log(`🩺 ${spec} (${grouped[spec].length}):`);
            grouped[spec].forEach(doc => {
                console.log(`   ${doc.id}. Dr. ${doc.name}`);
                console.log(`      📋 ${doc.qualification || 'N/A'}`);
                console.log(`      🏥 ${doc.clinic_name || 'No clinic'}`);
                console.log(`      📱 ${doc.whatsapp}`);
            });
            console.log('');
        });
        
        // Test 4: Check specialization distribution per clinic
        console.log('📊 Test 4: Specialization distribution per clinic...\n');
        
        for (const clinic of clinics) {
            const clinicDoctors = doctors.filter(d => d.clinic_name === clinic.name);
            const specs = [...new Set(clinicDoctors.map(d => d.specialization).filter(Boolean))];
            
            console.log(`🏥 ${clinic.name}:`);
            console.log(`   Total doctors: ${clinicDoctors.length}`);
            console.log(`   Specializations available: ${specs.length}`);
            
            if (specs.length > 0) {
                console.log(`   Specialties:`);
                specs.forEach(s => {
                    const count = clinicDoctors.filter(d => d.specialization === s).length;
                    console.log(`      - ${s} (${count})`);
                });
            } else {
                console.log('   ⚠️  No specializations configured');
            }
            console.log('');
        }
        
        // Test 5: Verify WhatsApp number format
        console.log('📊 Test 5: Verifying WhatsApp number formats...');
        
        const invalidWhatsApp = doctors.filter(d => {
            return !d.whatsapp || !d.whatsapp.startsWith('whatsapp:+');
        });
        
        if (invalidWhatsApp.length > 0) {
            console.log(`❌ FAIL: ${invalidWhatsApp.length} doctor(s) with invalid WhatsApp format`);
            invalidWhatsApp.forEach(d => {
                console.log(`   - Dr. ${d.name}: ${d.whatsapp || 'NULL'}`);
            });
            console.log('');
            allTestsPassed = false;
        } else {
            console.log('✅ PASS: All WhatsApp numbers properly formatted\n');
        }
        
        // Test 6: Check appointments table schema
        console.log('📊 Test 6: Checking appointments table schema...');
        
        const columns = await sql`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'appointments'
            AND column_name IN ('doctor_id', 'clinic_id', 'patient_name', 'appointment_date', 'appointment_time')
            ORDER BY column_name
        `;
        
        const hasDoctorid = columns.some(c => c.column_name === 'doctor_id');
        
        if (!hasDoctorid) {
            console.log('❌ FAIL: appointments table missing doctor_id column');
            console.log('   Run: node migration-add-doctor-id.js\n');
            allTestsPassed = false;
        } else {
            console.log('✅ PASS: appointments table has doctor_id column');
            console.log('   Columns found:');
            columns.forEach(c => {
                console.log(`      - ${c.column_name} (${c.data_type})`);
            });
            console.log('');
        }
        
        // Test 7: Sample appointment with doctor info
        console.log('📊 Test 7: Testing appointment query with doctor info...');
        
        const sampleAppt = await sql`
            SELECT 
                a.id,
                a.patient_name,
                a.appointment_date,
                a.appointment_time,
                a.status,
                c.name as clinic_name,
                d.name as doctor_name,
                d.specialization
            FROM appointments a
            LEFT JOIN clinics c ON a.clinic_id = c.id
            LEFT JOIN doctors d ON a.doctor_id = d.id
            LIMIT 1
        `;
        
        if (sampleAppt.length > 0) {
            console.log('✅ PASS: Successfully queried appointments with doctor info');
            console.log('   Sample appointment:');
            console.log(`      ID: ${sampleAppt[0].id}`);
            console.log(`      Patient: ${sampleAppt[0].patient_name}`);
            console.log(`      Clinic: ${sampleAppt[0].clinic_name}`);
            console.log(`      Doctor: ${sampleAppt[0].doctor_name || 'Not assigned'}`);
            console.log(`      Specialization: ${sampleAppt[0].specialization || 'N/A'}`);
            console.log('');
        } else {
            console.log('⚠️  INFO: No appointments in database yet\n');
        }
        
        // Final Summary
        console.log('═══════════════════════════════════════════════════════════');
        if (allTestsPassed) {
            console.log('✅ ALL TESTS PASSED - READY FOR DEPLOYMENT');
        } else {
            console.log('❌ SOME TESTS FAILED - FIX ISSUES BEFORE DEPLOYMENT');
        }
        console.log('═══════════════════════════════════════════════════════════\n');
        
        // Recommendations
        console.log('📋 RECOMMENDATIONS:\n');
        
        if (withoutSpec && withoutSpec.length > 0) {
            console.log('⚠️  Add specializations to doctors without them:');
            console.log('   UPDATE doctors SET specialization = \'General Physician\'');
            console.log('   WHERE specialization IS NULL;\n');
        }
        
        if (invalidWhatsApp.length > 0) {
            console.log('⚠️  Fix WhatsApp number formats:');
            console.log('   UPDATE doctors SET whatsapp = \'whatsapp:\' || whatsapp');
            console.log('   WHERE whatsapp NOT LIKE \'whatsapp:%\';\n');
        }
        
        if (!hasDoctorid) {
            console.log('⚠️  Run database migration:');
            console.log('   node migration-add-doctor-id.js\n');
        }
        
        if (allTestsPassed) {
            console.log('✅ System ready! Deploy the enhanced bot:');
            console.log('   node bot-enhanced.js\n');
        }
        
        process.exit(allTestsPassed ? 0 : 1);
        
    } catch (error) {
        console.error('\n❌ Test failed with error:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

runTests();

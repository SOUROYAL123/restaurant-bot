/**
 * ═══════════════════════════════════════════════════════════
 * DIAGNOSE MANUAL APPROVAL ISSUES
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function diagnoseManualApproval() {
    console.log('\n🔍 DIAGNOSING MANUAL APPROVAL ISSUES\n');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    try {
        // 1. Check if there are any clinics
        console.log('1️⃣ Checking clinics...\n');
        const clinics = await sql`SELECT * FROM clinics ORDER BY id`;
        
        if (clinics.length === 0) {
            console.log('❌ NO CLINICS FOUND\n');
            console.log('Solution: Add clinics to database\n');
            return;
        }
        
        console.log(`✅ Found ${clinics.length} clinic(s)\n`);
        
        clinics.forEach(c => {
            console.log(`   Clinic ID ${c.id}: ${c.name}`);
            console.log(`   Doctor: Dr. ${c.doctor_name}`);
            console.log(`   WhatsApp: ${c.doctor_whatsapp || '⚠️  NOT SET'}`);
            console.log(`   Status: ${c.status}`);
            console.log('');
        });
        
        // 2. Check for missing WhatsApp numbers
        console.log('2️⃣ Checking doctor WhatsApp numbers...\n');
        const missingWhatsApp = clinics.filter(c => !c.doctor_whatsapp);
        
        if (missingWhatsApp.length > 0) {
            console.log(`⚠️  WARNING: ${missingWhatsApp.length} clinic(s) missing WhatsApp:\n`);
            missingWhatsApp.forEach(c => {
                console.log(`   ❌ Clinic ID ${c.id}: ${c.name} - Dr. ${c.doctor_name}`);
                console.log(`      Fix: UPDATE clinics SET doctor_whatsapp = 'whatsapp:+919876543210' WHERE id = ${c.id};\n`);
            });
        } else {
            console.log('✅ All clinics have WhatsApp configured\n');
        }
        
        // 3. Check pending appointments
        console.log('3️⃣ Checking pending appointments...\n');
        const pending = await sql`
            SELECT a.*, c.name as clinic_name, c.doctor_name, c.doctor_whatsapp
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE a.status = 'pending'
            ORDER BY a.created_at DESC
        `;
        
        if (pending.length === 0) {
            console.log('ℹ️  No pending appointments found\n');
            console.log('This is normal if all appointments are confirmed/rejected\n');
        } else {
            console.log(`📋 Found ${pending.length} pending appointment(s):\n`);
            
            pending.forEach(a => {
                console.log(`   Appointment #${a.id}`);
                console.log(`   ├─ Patient: ${a.patient_name}`);
                console.log(`   ├─ Phone: ${a.patient_phone}`);
                console.log(`   ├─ Clinic: ${a.clinic_name}`);
                console.log(`   ├─ Doctor: Dr. ${a.doctor_name}`);
                console.log(`   ├─ Doctor WhatsApp: ${a.doctor_whatsapp || '⚠️  NOT SET'}`);
                console.log(`   ├─ Date: ${new Date(a.appointment_date).toLocaleDateString('en-IN')}`);
                console.log(`   ├─ Time: ${a.appointment_time}`);
                console.log(`   ├─ Created: ${new Date(a.created_at).toLocaleString('en-IN')}`);
                console.log(`   └─ Status: ${a.status}\n`);
                
                if (a.doctor_whatsapp) {
                    console.log(`   ✅ Doctor can approve with: APPROVE #${a.id}`);
                    console.log(`   ✅ Doctor can reject with: REJECT #${a.id}\n`);
                } else {
                    console.log(`   ❌ Doctor WhatsApp NOT SET - Cannot approve!\n`);
                }
            });
        }
        
        // 4. Test doctor phone number format
        console.log('4️⃣ Checking doctor phone number formats...\n');
        
        let hasFormatIssues = false;
        
        for (const clinic of clinics) {
            if (!clinic.doctor_whatsapp) continue;
            
            const phone = clinic.doctor_whatsapp;
            const hasWhatsAppPrefix = phone.startsWith('whatsapp:');
            const hasPlus = phone.includes('+');
            const digits = phone.replace(/\D/g, '').length;
            
            if (!hasWhatsAppPrefix || !hasPlus || digits < 10) {
                hasFormatIssues = true;
                console.log(`   ⚠️  Clinic ID ${clinic.id}: ${clinic.name}`);
                console.log(`      Current: ${phone}`);
                console.log(`      Issues:`);
                if (!hasWhatsAppPrefix) console.log(`         - Missing 'whatsapp:' prefix`);
                if (!hasPlus) console.log(`         - Missing '+' country code`);
                if (digits < 10) console.log(`         - Too few digits (${digits})`);
                console.log(`      Correct format: whatsapp:+919876543210\n`);
            }
        }
        
        if (!hasFormatIssues) {
            console.log('✅ All phone numbers are correctly formatted\n');
        }
        
        // 5. Check recent appointment activity
        console.log('5️⃣ Checking recent appointment activity...\n');
        
        const recentActivity = await sql`
            SELECT 
                status,
                COUNT(*) as count,
                MAX(updated_at) as last_update
            FROM appointments
            WHERE DATE(created_at) >= CURRENT_DATE - INTERVAL '7 days'
            GROUP BY status
        `;
        
        if (recentActivity.length === 0) {
            console.log('ℹ️  No appointments in the last 7 days\n');
        } else {
            console.log('📊 Last 7 days:\n');
            recentActivity.forEach(r => {
                console.log(`   ${r.status}: ${r.count} appointment(s)`);
                console.log(`   Last update: ${new Date(r.last_update).toLocaleString('en-IN')}\n`);
            });
        }
        
        // 6. Test doctor authentication
        console.log('6️⃣ Testing doctor authentication logic...\n');
        
        const testPhone = 'whatsapp:+919876543210';
        console.log(`   Test: Doctor with phone ${testPhone}\n`);
        
        const testClinic = await sql`
            SELECT * FROM clinics 
            WHERE doctor_whatsapp = ${testPhone}
            LIMIT 1
        `;
        
        if (testClinic.length > 0) {
            console.log(`   ✅ Found clinic: ${testClinic[0].name}`);
            console.log(`   ✅ Doctor can send commands\n`);
        } else {
            console.log(`   ❌ No clinic found with this WhatsApp number`);
            console.log(`   ℹ️  This is normal if you haven't set up this test number\n`);
        }
        
        // 7. Summary and recommendations
        console.log('═══════════════════════════════════════════════════════════\n');
        console.log('📋 SUMMARY & RECOMMENDATIONS\n');
        console.log('═══════════════════════════════════════════════════════════\n');
        
        const issues = [];
        
        if (clinics.length === 0) {
            issues.push('❌ No clinics in database');
        }
        
        if (missingWhatsApp.length > 0) {
            issues.push(`⚠️  ${missingWhatsApp.length} clinic(s) missing WhatsApp`);
        }
        
        if (hasFormatIssues) {
            issues.push('⚠️  Some WhatsApp numbers have format issues');
        }
        
        if (pending.length > 0 && missingWhatsApp.length > 0) {
            issues.push('❌ Pending appointments but doctors cannot approve');
        }
        
        if (issues.length === 0) {
            console.log('✅ NO ISSUES FOUND!\n');
            console.log('Manual approval should be working correctly.\n');
            console.log('If it\'s still not working:\n');
            console.log('1. Check Render logs for errors');
            console.log('2. Verify doctor is sending: APPROVE #123 or REJECT #123');
            console.log('3. Verify doctor\'s WhatsApp matches database exactly\n');
        } else {
            console.log('❌ ISSUES FOUND:\n');
            issues.forEach(issue => console.log(`   ${issue}\n`));
            
            console.log('\n🔧 FIXES:\n');
            
            if (missingWhatsApp.length > 0) {
                console.log('To add WhatsApp numbers:\n');
                missingWhatsApp.forEach(c => {
                    console.log(`UPDATE clinics SET doctor_whatsapp = 'whatsapp:+919876543210' WHERE id = ${c.id};`);
                });
                console.log('');
            }
            
            if (hasFormatIssues) {
                console.log('Correct format: whatsapp:+[country_code][phone]\n');
                console.log('Examples:');
                console.log('  India: whatsapp:+919876543210');
                console.log('  US: whatsapp:+11234567890\n');
            }
        }
        
        console.log('═══════════════════════════════════════════════════════════\n');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error);
    }
}

// Run the diagnostic
diagnoseManualApproval();

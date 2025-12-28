/**
 * ═══════════════════════════════════════════════════════════
 * DIAGNOSE DOCTOR NOTIFICATION ISSUES
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const twilio = require('twilio');

const sql = neon(process.env.DATABASE_URL);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function diagnoseDoctorNotifications() {
    console.log('\n🔍 DIAGNOSING DOCTOR NOTIFICATION ISSUES\n');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    try {
        // 1. Check Twilio credentials
        console.log('1️⃣ Checking Twilio Configuration...\n');
        
        if (!process.env.TWILIO_ACCOUNT_SID) {
            console.log('❌ TWILIO_ACCOUNT_SID not set\n');
            return;
        }
        
        if (!process.env.TWILIO_AUTH_TOKEN) {
            console.log('❌ TWILIO_AUTH_TOKEN not set\n');
            return;
        }
        
        if (!process.env.WABA_NUMBER) {
            console.log('❌ WABA_NUMBER not set\n');
            return;
        }
        
        console.log(`✅ TWILIO_ACCOUNT_SID: ${process.env.TWILIO_ACCOUNT_SID.substring(0, 10)}...`);
        console.log(`✅ WABA_NUMBER: ${process.env.WABA_NUMBER}\n`);
        
        // 2. Check recent appointments
        console.log('2️⃣ Checking Recent Appointments...\n');
        
        const recentAppts = await sql`
            SELECT 
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_date,
                a.appointment_time,
                a.status,
                a.created_at,
                c.id as clinic_id,
                c.name as clinic_name,
                c.doctor_name,
                c.doctor_whatsapp
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            ORDER BY a.created_at DESC
            LIMIT 5
        `;
        
        if (recentAppts.length === 0) {
            console.log('ℹ️  No appointments found\n');
        } else {
            console.log(`📋 Found ${recentAppts.length} recent appointment(s):\n`);
            
            recentAppts.forEach((appt, i) => {
                console.log(`${i + 1}. Appointment #${appt.id}`);
                console.log(`   Patient: ${appt.patient_name}`);
                console.log(`   Clinic: ${appt.clinic_name}`);
                console.log(`   Doctor: Dr. ${appt.doctor_name}`);
                console.log(`   Doctor WhatsApp: ${appt.doctor_whatsapp || '❌ NOT SET'}`);
                console.log(`   Status: ${appt.status}`);
                console.log(`   Created: ${new Date(appt.created_at).toLocaleString('en-IN')}\n`);
            });
        }
        
        // 3. Check doctor WhatsApp formats
        console.log('3️⃣ Checking Doctor WhatsApp Formats...\n');
        
        const clinics = await sql`SELECT * FROM clinics ORDER BY id`;
        
        let formatIssues = [];
        
        clinics.forEach(clinic => {
            if (!clinic.doctor_whatsapp) {
                formatIssues.push({
                    id: clinic.id,
                    name: clinic.name,
                    issue: 'NOT SET',
                    fix: `UPDATE clinics SET doctor_whatsapp = 'whatsapp:+919876543210' WHERE id = ${clinic.id};`
                });
            } else {
                const phone = clinic.doctor_whatsapp;
                const issues = [];
                
                if (!phone.startsWith('whatsapp:')) {
                    issues.push('Missing "whatsapp:" prefix');
                }
                
                if (!phone.includes('+')) {
                    issues.push('Missing "+" country code');
                }
                
                const digits = phone.replace(/\D/g, '');
                if (digits.length < 10) {
                    issues.push(`Too few digits (${digits.length})`);
                }
                
                if (issues.length > 0) {
                    formatIssues.push({
                        id: clinic.id,
                        name: clinic.name,
                        current: phone,
                        issue: issues.join(', '),
                        fix: `UPDATE clinics SET doctor_whatsapp = 'whatsapp:+91${digits.substring(digits.length - 10)}' WHERE id = ${clinic.id};`
                    });
                }
            }
        });
        
        if (formatIssues.length === 0) {
            console.log('✅ All doctor WhatsApp numbers are correctly formatted\n');
        } else {
            console.log(`⚠️  Found ${formatIssues.length} issue(s):\n`);
            
            formatIssues.forEach((issue, i) => {
                console.log(`${i + 1}. Clinic ID ${issue.id}: ${issue.name}`);
                if (issue.current) {
                    console.log(`   Current: ${issue.current}`);
                }
                console.log(`   Issue: ${issue.issue}`);
                console.log(`   Fix: ${issue.fix}\n`);
            });
        }
        
        // 4. Test Twilio API connection
        console.log('4️⃣ Testing Twilio API Connection...\n');
        
        try {
            const account = await twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
            console.log(`✅ Twilio API connection successful`);
            console.log(`   Account Status: ${account.status}`);
            console.log(`   Account Type: ${account.type}\n`);
        } catch (error) {
            console.log(`❌ Twilio API connection failed`);
            console.log(`   Error: ${error.message}\n`);
        }
        
        // 5. Test sending message to doctor
        console.log('5️⃣ Test Doctor Notification...\n');
        
        const testClinic = clinics.find(c => c.doctor_whatsapp && c.doctor_whatsapp.startsWith('whatsapp:+'));
        
        if (!testClinic) {
            console.log('⚠️  No clinic with valid WhatsApp number for testing\n');
        } else {
            console.log(`📱 Test notification to: ${testClinic.doctor_name}`);
            console.log(`   Clinic: ${testClinic.name}`);
            console.log(`   WhatsApp: ${testClinic.doctor_whatsapp}\n`);
            
            const testMessage = `🧪 *TEST NOTIFICATION*\n\nThis is a test message from your clinic appointment bot.\n\nIf you receive this, notifications are working! ✅\n\n━━━━━━━━━━━━━━━━━━━━━\nClinic: ${testClinic.name}\nDoctor: Dr. ${testClinic.doctor_name}\nTime: ${new Date().toLocaleString('en-IN')}`;
            
            console.log('Sending test message...\n');
            
            try {
                const message = await twilioClient.messages.create({
                    from: process.env.WABA_NUMBER,
                    to: testClinic.doctor_whatsapp,
                    body: testMessage
                });
                
                console.log(`✅ Test message sent successfully!`);
                console.log(`   Message SID: ${message.sid}`);
                console.log(`   Status: ${message.status}`);
                console.log(`   To: ${message.to}`);
                console.log(`\n📱 Check ${testClinic.doctor_name}'s WhatsApp for the test message!\n`);
                
            } catch (error) {
                console.log(`❌ Failed to send test message`);
                console.log(`   Error: ${error.message}`);
                console.log(`   Code: ${error.code}`);
                
                if (error.code === 21608) {
                    console.log(`\n⚠️  This number is not registered with WhatsApp or not in approved list`);
                }
                
                if (error.code === 63007) {
                    console.log(`\n⚠️  The "from" number (${process.env.WABA_NUMBER}) is not enabled for WhatsApp`);
                }
                
                console.log('');
            }
        }
        
        // 6. Check Twilio message logs
        console.log('6️⃣ Checking Recent Twilio Messages...\n');
        
        try {
            const messages = await twilioClient.messages.list({ limit: 10 });
            
            if (messages.length === 0) {
                console.log('ℹ️  No recent messages found\n');
            } else {
                console.log(`📨 Last 10 messages:\n`);
                
                messages.forEach((msg, i) => {
                    console.log(`${i + 1}. ${msg.direction === 'outbound-api' ? '📤' : '📥'} ${msg.direction}`);
                    console.log(`   To: ${msg.to}`);
                    console.log(`   Status: ${msg.status}`);
                    console.log(`   Date: ${new Date(msg.dateCreated).toLocaleString('en-IN')}`);
                    console.log(`   SID: ${msg.sid}`);
                    
                    if (msg.errorCode) {
                        console.log(`   ❌ Error: ${msg.errorCode} - ${msg.errorMessage}`);
                    }
                    
                    console.log('');
                });
            }
        } catch (error) {
            console.log(`❌ Could not fetch message logs`);
            console.log(`   Error: ${error.message}\n`);
        }
        
        // 7. Summary
        console.log('═══════════════════════════════════════════════════════════');
        console.log('📋 SUMMARY\n');
        console.log('═══════════════════════════════════════════════════════════\n');
        
        const issues = [];
        
        if (formatIssues.length > 0) {
            issues.push(`${formatIssues.length} clinic(s) with WhatsApp format issues`);
        }
        
        if (issues.length === 0) {
            console.log('✅ NO MAJOR ISSUES FOUND\n');
            console.log('If doctors still not receiving notifications:\n');
            console.log('1. Check if test message was received');
            console.log('2. Verify doctor WhatsApp numbers are correct');
            console.log('3. Check Twilio message logs in Twilio Console');
            console.log('4. Ensure WABA number is approved and active\n');
        } else {
            console.log('❌ ISSUES FOUND:\n');
            issues.forEach(issue => console.log(`   - ${issue}`));
            console.log('\n🔧 Run the SQL fixes shown above to resolve issues\n');
        }
        
        console.log('═══════════════════════════════════════════════════════════\n');
        
    } catch (error) {
        console.error('❌ Diagnostic failed:', error.message);
        console.error(error);
    }
}

// Run diagnostic
diagnoseDoctorNotifications();

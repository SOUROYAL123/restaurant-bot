require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function checkStatus() {
    console.log('═══════════════════════════════════════════════');
    console.log('📊 SYSTEM STATUS DASHBOARD');
    console.log('═══════════════════════════════════════════════\n');
    console.log(`⏰ ${new Date().toLocaleString('en-IN')}\n`);
    
    try {
        // Overall stats
        const overallStats = await sql`
            SELECT 
                COUNT(*) FILTER (WHERE status = 'pending') as total_pending,
                COUNT(*) FILTER (WHERE status = 'confirmed') as total_confirmed,
                COUNT(*) FILTER (WHERE status = 'rejected') as total_rejected,
                COUNT(*) FILTER (WHERE auto_approved = true) as total_auto_approved,
                COUNT(*) FILTER (WHERE auto_rejected = true) as total_auto_rejected,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as last_24h
            FROM appointments
        `;
        
        console.log('🌍 Overall Statistics:');
        console.log(`   ⏳ Pending: ${overallStats[0].total_pending}`);
        console.log(`   ✅ Confirmed: ${overallStats[0].total_confirmed}`);
        console.log(`   ❌ Rejected: ${overallStats[0].total_rejected}`);
        console.log(`   🤖 Auto-approved: ${overallStats[0].total_auto_approved}`);
        console.log(`   🤖 Auto-rejected: ${overallStats[0].total_auto_rejected}`);
        console.log(`   📅 Last 24h: ${overallStats[0].last_24h}`);
        console.log('\n' + '─'.repeat(47) + '\n');
        
        // Per-clinic stats
        const clinicStats = await sql`
            SELECT 
                c.id,
                c.name,
                c.doctor_name,
                c.auto_approve,
                c.auto_approve_after_hours,
                c.auto_reject,
                c.auto_reject_after_hours,
                c.google_sheet_id,
                COUNT(a.id) FILTER (WHERE a.status = 'pending') as pending,
                COUNT(a.id) FILTER (WHERE a.status = 'confirmed') as confirmed,
                COUNT(a.id) FILTER (WHERE a.status = 'rejected') as rejected,
                COUNT(a.id) FILTER (WHERE a.auto_approved = true) as auto_approved,
                COUNT(a.id) FILTER (WHERE a.auto_rejected = true) as auto_rejected
            FROM clinics c
            LEFT JOIN appointments a ON c.id = a.clinic_id
            WHERE c.status = 'active'
            GROUP BY c.id, c.name, c.doctor_name, c.auto_approve, 
                     c.auto_approve_after_hours, c.auto_reject, 
                     c.auto_reject_after_hours, c.google_sheet_id
            ORDER BY c.id
        `;
        
        console.log('🏥 Clinic Breakdown:\n');
        
        clinicStats.forEach((clinic, i) => {
            console.log(`   ${i + 1}. ${clinic.name} (ID: ${clinic.id})`);
            console.log(`      👨‍⚕️ ${clinic.doctor_name}`);
            console.log(`      📊 Stats:`);
            console.log(`         ⏳ Pending: ${clinic.pending}`);
            console.log(`         ✅ Confirmed: ${clinic.confirmed}`);
            console.log(`         ❌ Rejected: ${clinic.rejected}`);
            console.log(`      🤖 Auto-actions:`);
            console.log(`         Approved: ${clinic.auto_approved}`);
            console.log(`         Rejected: ${clinic.auto_rejected}`);
            console.log(`      ⚙️ Settings:`);
            console.log(`         Auto-approve: ${clinic.auto_approve ? `✅ (${clinic.auto_approve_after_hours}h)` : '❌'}`);
            console.log(`         Auto-reject: ${clinic.auto_reject ? `✅ (${clinic.auto_reject_after_hours}h)` : '❌'}`);
            console.log(`         Google Sheet: ${clinic.google_sheet_id ? '✅' : '❌'}`);
            console.log('');
        });
        
        // Pending appointments needing attention
        const needsAttention = await sql`
            SELECT 
                a.id,
                a.patient_name,
                a.appointment_date,
                a.appointment_time,
                c.name as clinic_name,
                c.auto_approve_after_hours,
                EXTRACT(EPOCH FROM (NOW() - a.created_at))/3600 as hours_pending
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE a.status = 'pending'
            ORDER BY a.created_at ASC
            LIMIT 10
        `;
        
        if (needsAttention.length > 0) {
            console.log('─'.repeat(47) + '\n');
            console.log('⚠️ Appointments Needing Attention:\n');
            
            needsAttention.forEach((appt, i) => {
                const hoursWaiting = Math.floor(appt.hours_pending);
                console.log(`   ${i + 1}. #${appt.id} - ${appt.patient_name}`);
                console.log(`      🏥 ${appt.clinic_name}`);
                console.log(`      📅 ${appt.appointment_date} @ ${appt.appointment_time}`);
                console.log(`      ⏱️ Waiting: ${hoursWaiting}h`);
                console.log('');
            });
        }
        
        console.log('═══════════════════════════════════════════════\n');
        
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Status check failed:', error.message);
        process.exit(1);
    }
}

checkStatus();

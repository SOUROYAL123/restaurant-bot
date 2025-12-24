require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function viewLogs() {
    console.log('📋 Recent Activity Logs\n');
    console.log('═══════════════════════════════════════════════\n');
    
    try {
        // Recent appointments
        const recentAppointments = await sql`
            SELECT 
                a.id,
                a.patient_name,
                a.appointment_date,
                a.appointment_time,
                a.status,
                c.name as clinic_name,
                a.created_at
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            ORDER BY a.created_at DESC
            LIMIT 20
        `;
        
        console.log('📅 Last 20 Appointments:\n');
        recentAppointments.forEach(appt => {
            const time = new Date(appt.created_at).toLocaleString('en-IN');
            const status = appt.status === 'confirmed' ? '✅' : 
                          appt.status === 'rejected' ? '❌' : 
                          appt.status === 'pending' ? '⏳' : '📋';
            
            console.log(`   ${status} #${appt.id} - ${appt.patient_name}`);
            console.log(`      🏥 ${appt.clinic_name}`);
            console.log(`      📅 ${appt.appointment_date} @ ${appt.appointment_time}`);
            console.log(`      🕒 ${time}`);
            console.log('');
        });
        
        // Recent sessions
        const activeSessions = await sql`
            SELECT 
                user_phone,
                stage,
                last_activity
            FROM sessions
            WHERE last_activity > NOW() - INTERVAL '1 hour'
            ORDER BY last_activity DESC
        `;
        
        if (activeSessions.length > 0) {
            console.log('─'.repeat(47) + '\n');
            console.log('👤 Active Sessions (Last Hour):\n');
            activeSessions.forEach(session => {
                console.log(`   📱 ${session.user_phone}`);
                console.log(`      Stage: ${session.stage}`);
                console.log(`      Last: ${new Date(session.last_activity).toLocaleTimeString('en-IN')}\n`);
            });
        }
        
        console.log('═══════════════════════════════════════════════\n');
        
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Failed to fetch logs:', error.message);
        process.exit(1);
    }
}

viewLogs();

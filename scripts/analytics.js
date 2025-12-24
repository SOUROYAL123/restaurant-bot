require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function showAnalytics() {
    console.log('📊 Analytics Dashboard\n');
    console.log('═══════════════════════════════════════════════\n');
    
    try {
        // Time-based stats
        const timeStats = await sql`
            SELECT 
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') as last_hour,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as last_24h,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as last_7d,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as last_30d
            FROM appointments
        `;
        
        console.log('📅 Appointments by Time Period:');
        console.log(`   Last Hour:   ${timeStats[0].last_hour}`);
        console.log(`   Last 24h:    ${timeStats[0].last_24h}`);
        console.log(`   Last 7 days: ${timeStats[0].last_7d}`);
        console.log(`   Last 30 days: ${timeStats[0].last_30d}\n`);
        
        // Status breakdown
        const statusStats = await sql`
            SELECT 
                status,
                COUNT(*) as count,
                ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER(), 2) as percentage
            FROM appointments
            GROUP BY status
            ORDER BY count DESC
        `;
        
        console.log('📊 Status Breakdown:');
        statusStats.forEach(stat => {
            console.log(`   ${stat.status.padEnd(15)} ${String(stat.count).padStart(4)} (${stat.percentage}%)`);
        });
        console.log('');
        
        // Auto-action stats
        const autoStats = await sql`
            SELECT 
                COUNT(*) FILTER (WHERE auto_approved = true) as auto_approved,
                COUNT(*) FILTER (WHERE auto_rejected = true) as auto_rejected
            FROM appointments
        `;
        
        console.log('🤖 Auto-Actions:');
        console.log(`   Auto-approved: ${autoStats[0].auto_approved}`);
        console.log(`   Auto-rejected: ${autoStats[0].auto_rejected}\n`);
        
        // Top clinics
        const topClinics = await sql`
            SELECT 
                c.name,
                COUNT(a.id) as total_appointments,
                COUNT(a.id) FILTER (WHERE a.status = 'confirmed') as confirmed
            FROM clinics c
            LEFT JOIN appointments a ON c.id = a.clinic_id
            GROUP BY c.id, c.name
            ORDER BY total_appointments DESC
            LIMIT 5
        `;
        
        console.log('🏆 Top Clinics by Appointments:');
        topClinics.forEach((clinic, i) => {
            console.log(`   ${i + 1}. ${clinic.name}: ${clinic.total_appointments} (${clinic.confirmed} confirmed)`);
        });
        console.log('');
        
        // Peak hours
        const peakHours = await sql`
            SELECT 
                EXTRACT(HOUR FROM created_at) as hour,
                COUNT(*) as count
            FROM appointments
            WHERE created_at > NOW() - INTERVAL '7 days'
            GROUP BY hour
            ORDER BY count DESC
            LIMIT 3
        `;
        
        console.log('⏰ Peak Booking Hours (Last 7 Days):');
        peakHours.forEach((peak, i) => {
            const hourFormatted = `${String(peak.hour).padStart(2, '0')}:00`;
            console.log(`   ${i + 1}. ${hourFormatted} - ${peak.count} bookings`);
        });
        
        console.log('\n═══════════════════════════════════════════════\n');
        
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Analytics failed:', error.message);
        process.exit(1);
    }
}

showAnalytics();

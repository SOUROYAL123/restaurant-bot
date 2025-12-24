require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const https = require('https');

const sql = neon(process.env.DATABASE_URL);

async function healthCheck() {
    console.log('🏥 System Health Check\n');
    console.log('═══════════════════════════════════════════════\n');
    
    let healthy = true;
    
    try {
        // 1. Database Health
        console.log('1️⃣ Database Connection:');
        const dbStart = Date.now();
        const dbResult = await sql`SELECT NOW() as current_time`;
        const dbLatency = Date.now() - dbStart;
        
        console.log(`   ✅ Connected (${dbLatency}ms)`);
        console.log(`   ⏰ Server Time: ${dbResult[0].current_time.toLocaleString('en-IN')}\n`);
        
        // 2. Environment Variables
        console.log('2️⃣ Environment Variables:');
        const requiredEnvVars = [
            'DATABASE_URL',
            'TWILIO_ACCOUNT_SID',
            'TWILIO_AUTH_TOKEN',
            'WABA_NUMBER'
        ];
        
        requiredEnvVars.forEach(varName => {
            if (process.env[varName]) {
                console.log(`   ✅ ${varName}`);
            } else {
                console.log(`   ❌ ${varName} - MISSING`);
                healthy = false;
            }
        });
        console.log('');
        
        // 3. Database Tables
        console.log('3️⃣ Database Tables:');
        const tables = await sql`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_type = 'BASE TABLE'
            ORDER BY table_name
        `;
        
        const requiredTables = ['clinics', 'customers', 'appointments', 'sessions'];
        requiredTables.forEach(tableName => {
            if (tables.some(t => t.table_name === tableName)) {
                console.log(`   ✅ ${tableName}`);
            } else {
                console.log(`   ❌ ${tableName} - MISSING`);
                healthy = false;
            }
        });
        console.log('');
        
        // 4. Active Clinics
        console.log('4️⃣ Active Clinics:');
        const clinics = await sql`
            SELECT id, name, status 
            FROM clinics 
            WHERE status = 'active'
        `;
        
        if (clinics.length > 0) {
            console.log(`   ✅ ${clinics.length} active clinic(s)`);
            clinics.forEach(clinic => {
                console.log(`      • ${clinic.name} (ID: ${clinic.id})`);
            });
        } else {
            console.log('   ⚠️ No active clinics found');
        }
        console.log('');
        
        // 5. Pending Appointments
        console.log('5️⃣ Pending Appointments:');
        const pending = await sql`
            SELECT COUNT(*) as count 
            FROM appointments 
            WHERE status = 'pending'
        `;
        console.log(`   📋 ${pending[0].count} pending\n`);
        
        // 6. System Summary
        console.log('═══════════════════════════════════════════════');
        if (healthy) {
            console.log('✅ SYSTEM HEALTHY\n');
            process.exit(0);
        } else {
            console.log('⚠️ SYSTEM ISSUES DETECTED\n');
            process.exit(1);
        }
        
    } catch (error) {
        console.error('❌ Health check failed:', error.message);
        process.exit(1);
    }
}

healthCheck();

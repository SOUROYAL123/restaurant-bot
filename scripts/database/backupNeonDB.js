require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const fs = require('fs');
const path = require('path');

const sql = neon(process.env.DATABASE_URL);

async function backupNeonDB() {
    console.log('💾 Starting Neon DB Backup...\n');
    
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(__dirname, '..', 'backups');
        
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        
        const backupFile = path.join(backupDir, `backup-${timestamp}.json`);
        
        // Backup all tables
        const backup = {
            timestamp: new Date().toISOString(),
            database: 'neondb',
            tables: {}
        };
        
        console.log('📦 Backing up tables...\n');
        
        // Clinics
        backup.tables.clinics = await sql`SELECT * FROM clinics`;
        console.log(`   ✓ Clinics: ${backup.tables.clinics.length} rows`);
        
        // Customers
        backup.tables.customers = await sql`SELECT * FROM customers`;
        console.log(`   ✓ Customers: ${backup.tables.customers.length} rows`);
        
        // Appointments
        backup.tables.appointments = await sql`SELECT * FROM appointments`;
        console.log(`   ✓ Appointments: ${backup.tables.appointments.length} rows`);
        
        // Sessions
        backup.tables.sessions = await sql`SELECT * FROM sessions`;
        console.log(`   ✓ Sessions: ${backup.tables.sessions.length} rows`);
        
        // Write to file
        fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
        
        const fileSize = fs.statSync(backupFile).size;
        
        console.log('\n✅ Backup completed!');
        console.log(`📁 File: ${backupFile}`);
        console.log(`💾 Size: ${(fileSize / 1024).toFixed(2)} KB\n`);
        
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Backup failed:', error.message);
        process.exit(1);
    }
}

backupNeonDB();
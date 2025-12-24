require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function runMigration() {
    try {
        const migrationFile = process.argv[2];
        
        if (!migrationFile) {
            console.error('❌ Please provide migration file path');
            console.log('Usage: node scripts/runMigration.js <migration-file.sql>');
            process.exit(1);
        }
        
        const migrationPath = path.join(process.cwd(), migrationFile);
        
        if (!fs.existsSync(migrationPath)) {
            console.error(`❌ Migration file not found: ${migrationPath}`);
            process.exit(1);
        }
        
        console.log(`🔄 Running migration: ${migrationFile}\n`);
        
        const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
        
        // Split by semicolon and execute each statement
        const statements = migrationSQL
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0 && !s.startsWith('--'));
        
        for (const statement of statements) {
            await sql.unsafe(statement);
        }
        
        console.log('✅ Migration completed successfully!\n');
        
        // Show updated clinics
        const clinics = await sql`
            SELECT id, name, doctor_whatsapp, auto_approve, auto_approve_after_hours,
                   auto_reject, auto_reject_after_hours, google_sheet_id
            FROM clinics
        `;
        
        console.log('📊 Updated Clinics:\n');
        clinics.forEach(clinic => {
            console.log(`Clinic #${clinic.id}: ${clinic.name}`);
            console.log(`  Doctor: ${clinic.doctor_whatsapp}`);
            console.log(`  Auto-approve: ${clinic.auto_approve ? `Yes (after ${clinic.auto_approve_after_hours}h)` : 'No'}`);
            console.log(`  Auto-reject: ${clinic.auto_reject ? `Yes (after ${clinic.auto_reject_after_hours}h)` : 'No'}`);
            console.log(`  Google Sheet: ${clinic.google_sheet_id || 'Not configured'}`);
            console.log('');
        });
        
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        console.error(error);
        process.exit(1);
    }
}

runMigration();

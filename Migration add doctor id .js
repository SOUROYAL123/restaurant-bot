/**
 * Database Migration: Add doctor_id to appointments table
 * This migration adds support for tracking which specific doctor
 * is assigned to each appointment
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function runMigration() {
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║    DATABASE MIGRATION: ADD DOCTOR SPECIALIZATION   ║');
    console.log('╚════════════════════════════════════════════════════╝\n');
    
    try {
        console.log('📊 Step 1: Checking current schema...\n');
        
        // Check if doctor_id column exists
        const columns = await sql`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'appointments' 
            AND column_name = 'doctor_id'
        `;
        
        if (columns.length > 0) {
            console.log('✅ doctor_id column already exists in appointments table\n');
        } else {
            console.log('➕ Adding doctor_id column to appointments table...');
            
            await sql`
                ALTER TABLE appointments
                ADD COLUMN doctor_id INTEGER,
                ADD CONSTRAINT fk_appointments_doctor
                    FOREIGN KEY (doctor_id) 
                    REFERENCES doctors(id)
                    ON DELETE SET NULL
            `;
            
            console.log('✅ doctor_id column added successfully\n');
        }
        
        // Add index for better query performance
        console.log('📊 Step 2: Creating index for doctor_id...');
        
        await sql`
            CREATE INDEX IF NOT EXISTS idx_appointments_doctor_id 
            ON appointments(doctor_id)
        `;
        
        console.log('✅ Index created successfully\n');
        
        // Verify the migration
        console.log('📊 Step 3: Verifying migration...\n');
        
        const verification = await sql`
            SELECT 
                column_name,
                data_type,
                is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'appointments' 
            AND column_name = 'doctor_id'
        `;
        
        if (verification.length > 0) {
            console.log('✅ Migration verified successfully!');
            console.log(`   Column: ${verification[0].column_name}`);
            console.log(`   Type: ${verification[0].data_type}`);
            console.log(`   Nullable: ${verification[0].is_nullable}\n`);
        }
        
        // Show sample data structure
        console.log('📊 Step 4: Sample appointment structure...\n');
        
        const sample = await sql`
            SELECT 
                a.id,
                a.patient_name,
                a.clinic_id,
                a.doctor_id,
                c.name as clinic_name,
                d.name as doctor_name,
                d.specialization
            FROM appointments a
            LEFT JOIN clinics c ON a.clinic_id = c.id
            LEFT JOIN doctors d ON a.doctor_id = d.id
            LIMIT 3
        `;
        
        if (sample.length > 0) {
            console.log('Sample appointments with doctor info:');
            sample.forEach(apt => {
                console.log(`\n  ID: ${apt.id}`);
                console.log(`  Patient: ${apt.patient_name}`);
                console.log(`  Clinic: ${apt.clinic_name}`);
                console.log(`  Doctor: ${apt.doctor_name || 'Not assigned'}`);
                console.log(`  Specialization: ${apt.specialization || 'N/A'}`);
            });
            console.log('');
        } else {
            console.log('No appointments in database yet.\n');
        }
        
        console.log('╔════════════════════════════════════════════════════╗');
        console.log('║        ✅ MIGRATION COMPLETED SUCCESSFULLY         ║');
        console.log('╚════════════════════════════════════════════════════╝\n');
        
        console.log('📋 What changed:');
        console.log('   ✅ Added doctor_id column to appointments table');
        console.log('   ✅ Added foreign key constraint to doctors table');
        console.log('   ✅ Created index for better query performance');
        console.log('   ✅ Appointments can now track specific doctors\n');
        
        console.log('🚀 Next steps:');
        console.log('   1. Deploy the enhanced bot (bot-enhanced.js)');
        console.log('   2. Test the doctor specialization flow');
        console.log('   3. Verify appointments are assigned to correct doctors\n');
        
        process.exit(0);
        
    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

runMigration();

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const readline = require('readline');

const sql = neon(process.env.DATABASE_URL);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function prompt(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer);
        });
    });
}

async function setupProduction() {
    console.log('═══════════════════════════════════════════════');
    console.log('🚀 PRODUCTION SETUP - Multi-Clinic WhatsApp Bot');
    console.log('═══════════════════════════════════════════════\n');
    
    try {
        // Step 1: Database connection check
        console.log('1️⃣ Testing database connection...');
        await sql`SELECT NOW()`;
        console.log('   ✅ Database connected\n');
        
        // Step 2: Run migrations
        console.log('2️⃣ Running production migrations...');
        
        // Add auto-approval columns
        await sql`
            ALTER TABLE clinics 
            ADD COLUMN IF NOT EXISTS auto_approve BOOLEAN DEFAULT false,
            ADD COLUMN IF NOT EXISTS auto_approve_after_hours INTEGER DEFAULT 24,
            ADD COLUMN IF NOT EXISTS auto_reject BOOLEAN DEFAULT false,
            ADD COLUMN IF NOT EXISTS auto_reject_after_hours INTEGER DEFAULT 48,
            ADD COLUMN IF NOT EXISTS google_sheet_id VARCHAR(100),
            ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'Asia/Kolkata'
        `;
        
        await sql`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS auto_approved BOOLEAN DEFAULT false,
            ADD COLUMN IF NOT EXISTS auto_rejected BOOLEAN DEFAULT false
        `;
        
        // Add indexes
        await sql`
            CREATE INDEX IF NOT EXISTS idx_appointments_pending 
            ON appointments(clinic_id, status) 
            WHERE status = 'pending'
        `;
        
        await sql`
            CREATE INDEX IF NOT EXISTS idx_appointments_created 
            ON appointments(created_at) 
            WHERE status = 'pending'
        `;
        
        console.log('   ✅ Migrations completed\n');
        
        // Step 3: Configure clinics
        console.log('3️⃣ Clinic Configuration\n');
        
        const setupAnother = await prompt('   Do you want to add/update a clinic? (yes/no): ');
        
        if (setupAnother.toLowerCase() === 'yes') {
            await configureClinic();
        }
        
        // Step 4: Summary
        console.log('\n4️⃣ System Summary\n');
        
        const clinics = await sql`
            SELECT 
                id,
                name,
                doctor_name,
                doctor_whatsapp,
                auto_approve,
                auto_approve_after_hours,
                auto_reject,
                auto_reject_after_hours,
                google_sheet_id,
                status
            FROM clinics
            ORDER BY id
        `;
        
        console.log('📊 Configured Clinics:\n');
        clinics.forEach((clinic, i) => {
            console.log(`   ${i + 1}. ${clinic.name}`);
            console.log(`      Doctor: ${clinic.doctor_name} (${clinic.doctor_whatsapp})`);
            console.log(`      Auto-approve: ${clinic.auto_approve ? `✅ After ${clinic.auto_approve_after_hours}h` : '❌'}`);
            console.log(`      Auto-reject: ${clinic.auto_reject ? `✅ After ${clinic.auto_reject_after_hours}h` : '❌'}`);
            console.log(`      Google Sheet: ${clinic.google_sheet_id || '❌ Not configured'}`);
            console.log(`      Status: ${clinic.status}`);
            console.log('');
        });
        
        // Step 5: Next steps
        console.log('═══════════════════════════════════════════════');
        console.log('✅ SETUP COMPLETE!\n');
        console.log('📋 Next Steps:');
        console.log('   1. Configure Google Sheets for each clinic');
        console.log('   2. Test booking flow: npm run dev');
        console.log('   3. Setup cron job on Render for auto-approval');
        console.log('   4. Monitor with: npm run status');
        console.log('═══════════════════════════════════════════════\n');
        
        rl.close();
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Setup failed:', error.message);
        rl.close();
        process.exit(1);
    }
}

async function configureClinic() {
    console.log('\n   ═══ Clinic Configuration ═══\n');
    
    const clinicId = await prompt('   Clinic ID (1 for first clinic, 2 for second, etc.): ');
    const clinicName = await prompt('   Clinic Name: ');
    const doctorName = await prompt('   Doctor Name: ');
    const doctorWhatsApp = await prompt('   Doctor WhatsApp (with country code, e.g., +919876543210): ');
    const autoApprove = await prompt('   Enable auto-approve? (yes/no): ');
    const autoApproveHours = autoApprove.toLowerCase() === 'yes' 
        ? await prompt('   Auto-approve after how many hours? (default 2): ') || '2'
        : '24';
    const autoReject = await prompt('   Enable auto-reject? (yes/no): ');
    const autoRejectHours = autoReject.toLowerCase() === 'yes'
        ? await prompt('   Auto-reject after how many hours? (default 24): ') || '24'
        : '48';
    const googleSheetId = await prompt('   Google Sheet ID (optional, press Enter to skip): ');
    
    const whatsappFormatted = doctorWhatsApp.startsWith('whatsapp:') 
        ? doctorWhatsApp 
        : `whatsapp:${doctorWhatsApp}`;
    
    await sql`
        INSERT INTO clinics (
            id, name, doctor_name, doctor_whatsapp,
            auto_approve, auto_approve_after_hours,
            auto_reject, auto_reject_after_hours,
            google_sheet_id,
            business_hours_start, business_hours_end,
            status
        ) VALUES (
            ${clinicId},
            ${clinicName},
            ${doctorName},
            ${whatsappFormatted},
            ${autoApprove.toLowerCase() === 'yes'},
            ${parseInt(autoApproveHours)},
            ${autoReject.toLowerCase() === 'yes'},
            ${parseInt(autoRejectHours)},
            ${googleSheetId || null},
            '09:00 AM',
            '06:00 PM',
            'active'
        )
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            doctor_name = EXCLUDED.doctor_name,
            doctor_whatsapp = EXCLUDED.doctor_whatsapp,
            auto_approve = EXCLUDED.auto_approve,
            auto_approve_after_hours = EXCLUDED.auto_approve_after_hours,
            auto_reject = EXCLUDED.auto_reject,
            auto_reject_after_hours = EXCLUDED.auto_reject_after_hours,
            google_sheet_id = EXCLUDED.google_sheet_id,
            updated_at = NOW()
    `;
    
    console.log(`\n   ✅ Clinic #${clinicId} configured successfully!\n`);
    
    const addAnother = await prompt('   Add another clinic? (yes/no): ');
    if (addAnother.toLowerCase() === 'yes') {
        await configureClinic();
    }
}

setupProduction();

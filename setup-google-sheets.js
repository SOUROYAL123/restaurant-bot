/**
 * ═══════════════════════════════════════════════════════════
 * Google Sheets Setup Guide
 * 
 * Interactive setup for Google Sheets integration
 * Usage: node setup-google-sheets.js
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const readline = require('readline');
const { neon } = require('@neondatabase/serverless');
const { initializeSheet, getSheetStats } = require('./googleSheets');

const sql = neon(process.env.DATABASE_URL);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => {
        rl.question(question, answer => resolve(answer));
    });
}

async function setupGoogleSheets() {
    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║     GOOGLE SHEETS INTEGRATION SETUP                   ║');
    console.log('╚═══════════════════════════════════════════════════════╝\n');
    
    try {
        // Step 1: Check environment variables
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('STEP 1: Checking Environment Variables\n');
        
        const hasEmail = !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
        const hasKey = !!process.env.GOOGLE_PRIVATE_KEY;
        
        console.log(`GOOGLE_SERVICE_ACCOUNT_EMAIL: ${hasEmail ? '✅ Configured' : '❌ Missing'}`);
        console.log(`GOOGLE_PRIVATE_KEY: ${hasKey ? '✅ Configured' : '❌ Missing'}\n`);
        
        if (!hasEmail || !hasKey) {
            console.log('⚠️  Google Sheets credentials not configured!\n');
            console.log('TO FIX THIS:\n');
            console.log('1. Go to: https://console.cloud.google.com/');
            console.log('2. Create new project (or select existing)');
            console.log('3. Enable Google Sheets API');
            console.log('4. Create Service Account:');
            console.log('   - IAM & Admin > Service Accounts > Create Service Account');
            console.log('   - Name: clinic-bot-sheets');
            console.log('   - Role: None needed\n');
            console.log('5. Create Key:');
            console.log('   - Click on service account');
            console.log('   - Keys tab > Add Key > Create new key');
            console.log('   - Type: JSON > Create');
            console.log('   - Download JSON file\n');
            console.log('6. Add to .env file:');
            console.log('   GOOGLE_SERVICE_ACCOUNT_EMAIL="client_email from JSON"');
            console.log('   GOOGLE_PRIVATE_KEY="private_key from JSON"\n');
            console.log('7. Also add to Render.com Environment Variables\n');
            
            rl.close();
            process.exit(1);
        }
        
        console.log('✅ Credentials configured!\n');
        
        // Step 2: Get clinic info
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('STEP 2: Select Clinic\n');
        
        const clinics = await sql`
            SELECT id, name, doctor_name, google_sheet_id
            FROM clinics
            WHERE status = 'active'
            ORDER BY id
        `;
        
        if (clinics.length === 0) {
            console.log('❌ No active clinics found!');
            rl.close();
            process.exit(1);
        }
        
        console.log('Available Clinics:\n');
        clinics.forEach(clinic => {
            const sheetStatus = clinic.google_sheet_id ? '✅ Sheet configured' : '❌ No sheet';
            console.log(`${clinic.id}. ${clinic.name} (${clinic.doctor_name}) - ${sheetStatus}`);
        });
        console.log('');
        
        const clinicId = await ask('Enter clinic ID to setup: ');
        const selectedClinic = clinics.find(c => c.id === parseInt(clinicId));
        
        if (!selectedClinic) {
            console.log('❌ Invalid clinic ID');
            rl.close();
            process.exit(1);
        }
        
        console.log(`\n✅ Selected: ${selectedClinic.name}\n`);
        
        // Step 3: Create/Configure Google Sheet
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('STEP 3: Google Sheet Setup\n');
        
        if (selectedClinic.google_sheet_id) {
            console.log(`Current Sheet ID: ${selectedClinic.google_sheet_id}\n`);
            const useExisting = await ask('Use existing sheet? (yes/no): ');
            
            if (useExisting.toLowerCase() === 'yes') {
                console.log('\nInitializing existing sheet...');
                const result = await initializeSheet(selectedClinic.google_sheet_id);
                
                if (result.success) {
                    console.log('✅ Sheet initialized!');
                    
                    // Get stats
                    const stats = await getSheetStats(selectedClinic.google_sheet_id);
                    if (stats) {
                        console.log('\n📊 Current Stats:');
                        console.log(`   Total Appointments: ${stats.total}`);
                        console.log(`   Pending: ${stats.pending}`);
                        console.log(`   Confirmed: ${stats.confirmed}`);
                        console.log(`   Rejected: ${stats.rejected}`);
                    }
                } else {
                    console.log(`❌ Error: ${result.error}`);
                }
                
                rl.close();
                process.exit(0);
            }
        }
        
        console.log('CREATE NEW GOOGLE SHEET:\n');
        console.log('1. Go to: https://sheets.google.com/');
        console.log(`2. Create new sheet, name it: "${selectedClinic.name} - Appointments"`);
        console.log(`3. Share sheet with: ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL}`);
        console.log('   - Click Share button');
        console.log('   - Add email address');
        console.log('   - Give "Editor" permission');
        console.log('   - UNCHECK "Notify people" (service accounts dont get emails)');
        console.log('   - Click Share\n');
        console.log('4. Copy Sheet ID from URL:');
        console.log('   https://docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit\n');
        
        const sheetId = await ask('Enter Sheet ID: ');
        
        if (!sheetId || sheetId.length < 20) {
            console.log('❌ Invalid Sheet ID');
            rl.close();
            process.exit(1);
        }
        
        // Step 4: Initialize sheet with headers
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('STEP 4: Initializing Sheet\n');
        
        const result = await initializeSheet(sheetId);
        
        if (!result.success) {
            console.log(`❌ Error: ${result.error}`);
            console.log('\nPossible issues:');
            console.log('1. Sheet not shared with service account');
            console.log('2. Wrong Sheet ID');
            console.log('3. Network/API error\n');
            rl.close();
            process.exit(1);
        }
        
        console.log('✅ Sheet initialized with headers!\n');
        
        // Step 5: Update database
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('STEP 5: Saving Configuration\n');
        
        await sql`
            UPDATE clinics
            SET google_sheet_id = ${sheetId}
            WHERE id = ${selectedClinic.id}
        `;
        
        console.log('✅ Configuration saved!\n');
        
        // Step 6: Update bot.js instructions
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('STEP 6: Update bot.js (Manual Step)\n');
        
        console.log('Add to bot.js after appointment creation:\n');
        console.log('```javascript');
        console.log('const { logToGoogleSheets } = require(\'./googleSheets\');');
        console.log('');
        console.log('// After creating appointment...');
        console.log('const appointment = await sql`INSERT INTO appointments...`;');
        console.log('');
        console.log('// Log to Google Sheets');
        console.log('const clinic = await sql`SELECT google_sheet_id FROM clinics WHERE id = ${clinicId}`;');
        console.log('if (clinic[0].google_sheet_id) {');
        console.log('    await logToGoogleSheets({');
        console.log('        ...appointment[0],');
        console.log('        clinic_name: clinic[0].name');
        console.log('    }, clinic[0].google_sheet_id);');
        console.log('}');
        console.log('```\n');
        
        // Final summary
        console.log('╔═══════════════════════════════════════════════════════╗');
        console.log('║              SETUP COMPLETE! 🎉                       ║');
        console.log('╚═══════════════════════════════════════════════════════╝\n');
        
        console.log('✅ Google Sheet configured for:', selectedClinic.name);
        console.log(`✅ Sheet ID: ${sheetId}`);
        console.log(`✅ Sheet URL: https://docs.google.com/spreadsheets/d/${sheetId}/edit\n`);
        
        console.log('NEXT STEPS:\n');
        console.log('1. Upload googleSheets.js to Render.com');
        console.log('2. Update bot.js with logToGoogleSheets calls');
        console.log('3. Add dependencies: npm install googleapis');
        console.log('4. Deploy to Render.com');
        console.log('5. Test by creating a new appointment\n');
        
        console.log('VERIFY:\n');
        console.log('- Create test appointment via WhatsApp');
        console.log('- Check Google Sheet for new row');
        console.log('- Confirm all columns populated correctly\n');
        
    } catch (error) {
        console.error('\n❌ Setup failed:', error.message);
        console.error(error.stack);
    } finally {
        rl.close();
    }
}

// Run setup
setupGoogleSheets();

// diagnose.js - Automated Bot Diagnostic Tool
require('dotenv').config();
const { Pool } = require('pg');

const CHECKS = {
    ENV: '1. Environment Variables',
    DB: '2. Database Connection',
    TWILIO: '3. Twilio Configuration',
    PAYMENT: '4. Payment Setup',
    SHEETS: '5. Google Sheets',
    DATA: '6. Restaurant Data'
};

let results = {
    passed: [],
    failed: [],
    warnings: []
};

function log(emoji, message) {
    console.log(`${emoji} ${message}`);
}

function pass(check, message) {
    results.passed.push({ check, message });
    log('✅', `${check}: ${message}`);
}

function fail(check, message) {
    results.failed.push({ check, message });
    log('❌', `${check}: ${message}`);
}

function warn(check, message) {
    results.warnings.push({ check, message });
    log('⚠️', `${check}: ${message}`);
}

async function checkEnvironment() {
    console.log('\n' + '='.repeat(50));
    log('🔍', 'Checking Environment Variables...');
    console.log('='.repeat(50));

    const required = {
        'DATABASE_URL': process.env.DATABASE_URL,
        'TWILIO_ACCOUNT_SID': process.env.TWILIO_ACCOUNT_SID,
        'TWILIO_AUTH_TOKEN': process.env.TWILIO_AUTH_TOKEN,
        'WABA_NUMBER': process.env.WABA_NUMBER
    };

    const optional = {
        'RAZORPAY_KEY_ID': process.env.RAZORPAY_KEY_ID,
        'RAZORPAY_KEY_SECRET': process.env.RAZORPAY_KEY_SECRET,
        'GOOGLE_APPS_SCRIPT_URL': process.env.GOOGLE_APPS_SCRIPT_URL
    };

    let allPresent = true;

    for (const [key, value] of Object.entries(required)) {
        if (value) {
            const display = key.includes('TOKEN') || key.includes('SECRET') || key.includes('URL')
                ? value.substring(0, 20) + '...'
                : value;
            pass(CHECKS.ENV, `${key} = ${display}`);
        } else {
            fail(CHECKS.ENV, `${key} is MISSING`);
            allPresent = false;
        }
    }

    for (const [key, value] of Object.entries(optional)) {
        if (value) {
            pass(CHECKS.ENV, `${key} configured (optional)`);
        } else {
            warn(CHECKS.ENV, `${key} not set (optional feature disabled)`);
        }
    }

    return allPresent;
}

async function checkDatabase() {
    console.log('\n' + '='.repeat(50));
    log('🔍', 'Checking Database Connection...');
    console.log('='.repeat(50));

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 5000
    });

    try {
        const client = await pool.connect();
        pass(CHECKS.DB, 'Connection successful');

        // Check tables
        const tables = ['restaurants', 'menu_items', 'orders', 'table_bookings'];
        for (const table of tables) {
            try {
                const result = await client.query(`SELECT COUNT(*) FROM ${table}`);
                const count = result.rows[0].count;
                if (count > 0) {
                    pass(CHECKS.DB, `Table '${table}' exists (${count} rows)`);
                } else {
                    warn(CHECKS.DB, `Table '${table}' exists but is EMPTY`);
                }
            } catch (err) {
                fail(CHECKS.DB, `Table '${table}' missing or inaccessible`);
            }
        }

        client.release();
        await pool.end();
        return true;

    } catch (error) {
        fail(CHECKS.DB, `Connection failed: ${error.message}`);
        try { await pool.end(); } catch (e) {}
        return false;
    }
}

async function checkTwilio() {
    console.log('\n' + '='.repeat(50));
    log('🔍', 'Checking Twilio Configuration...');
    console.log('='.repeat(50));

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const number = process.env.WABA_NUMBER;

    if (!sid || !token || !number) {
        fail(CHECKS.TWILIO, 'Credentials missing');
        return false;
    }

    // Validate format
    if (sid.startsWith('AC') && sid.length === 34) {
        pass(CHECKS.TWILIO, `Account SID format valid: ${sid}`);
    } else {
        fail(CHECKS.TWILIO, `Invalid Account SID format: ${sid}`);
    }

    if (token.length === 32) {
        pass(CHECKS.TWILIO, `Auth Token format valid (32 chars)`);
    } else {
        warn(CHECKS.TWILIO, `Auth Token length unusual: ${token.length} chars`);
    }

    if (number.startsWith('whatsapp:+')) {
        pass(CHECKS.TWILIO, `WhatsApp number format: ${number}`);
    } else {
        fail(CHECKS.TWILIO, `Invalid WhatsApp number format: ${number} (should start with whatsapp:+)`);
    }

    log('💡', 'To test Twilio live, try sending a test message from the bot');

    return true;
}

async function checkPayment() {
    console.log('\n' + '='.repeat(50));
    log('🔍', 'Checking Payment Configuration...');
    console.log('='.repeat(50));

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const enabled = process.env.PAYMENT_ENABLED;

    if (enabled === 'true') {
        if (keyId && keySecret) {
            pass(CHECKS.PAYMENT, 'Razorpay configured and enabled');
            log('💡', `Key ID: ${keyId}`);
        } else {
            fail(CHECKS.PAYMENT, 'Payment enabled but credentials missing');
        }
    } else {
        warn(CHECKS.PAYMENT, 'Payment disabled (PAYMENT_ENABLED=false or not set)');
        log('💡', 'Set PAYMENT_ENABLED=true to enable online payments');
    }
}

async function checkGoogleSheets() {
    console.log('\n' + '='.repeat(50));
    log('🔍', 'Checking Google Sheets Integration...');
    console.log('='.repeat(50));

    const scriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL;
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

    if (scriptUrl && email) {
        pass(CHECKS.SHEETS, 'Google Sheets configured');
        log('💡', `Script URL: ${scriptUrl.substring(0, 50)}...`);
        log('💡', `Service Account: ${email}`);
    } else {
        warn(CHECKS.SHEETS, 'Google Sheets not configured (optional)');
    }
}

async function checkRestaurantData() {
    console.log('\n' + '='.repeat(50));
    log('🔍', 'Checking Restaurant Data...');
    console.log('='.repeat(50));

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const client = await pool.connect();

        const restaurants = await client.query(
            'SELECT id, name, phone, active FROM restaurants ORDER BY id'
        );

        if (restaurants.rows.length === 0) {
            fail(CHECKS.DATA, 'No restaurants in database!');
            log('💡', 'Add restaurants using SQL or admin panel');
        } else {
            pass(CHECKS.DATA, `Found ${restaurants.rows.length} restaurant(s)`);
            
            for (const r of restaurants.rows) {
                const menuCount = await client.query(
                    'SELECT COUNT(*) FROM menu_items WHERE restaurant_id = $1',
                    [r.id]
                );
                const items = parseInt(menuCount.rows[0].count);
                
                if (r.active) {
                    if (items > 0) {
                        pass(CHECKS.DATA, `${r.name}: ${items} menu items, ACTIVE`);
                    } else {
                        warn(CHECKS.DATA, `${r.name}: No menu items but ACTIVE`);
                    }
                    if (r.phone) {
                        pass(CHECKS.DATA, `${r.name}: Owner phone ${r.phone}`);
                    } else {
                        warn(CHECKS.DATA, `${r.name}: No owner phone (notifications disabled)`);
                    }
                } else {
                    warn(CHECKS.DATA, `${r.name}: INACTIVE`);
                }
            }
        }

        client.release();
        await pool.end();

    } catch (error) {
        fail(CHECKS.DATA, `Data check failed: ${error.message}`);
        try { await pool.end(); } catch (e) {}
    }
}

function printSummary() {
    console.log('\n' + '='.repeat(50));
    console.log('📊 DIAGNOSTIC SUMMARY');
    console.log('='.repeat(50));

    console.log(`\n✅ Passed: ${results.passed.length}`);
    console.log(`❌ Failed: ${results.failed.length}`);
    console.log(`⚠️ Warnings: ${results.warnings.length}`);

    if (results.failed.length > 0) {
        console.log('\n❌ CRITICAL ISSUES:');
        results.failed.forEach(f => {
            console.log(`   • ${f.check}: ${f.message}`);
        });
    }

    if (results.warnings.length > 0) {
        console.log('\n⚠️ WARNINGS:');
        results.warnings.forEach(w => {
            console.log(`   • ${w.check}: ${w.message}`);
        });
    }

    console.log('\n' + '='.repeat(50));
    
    if (results.failed.length === 0) {
        console.log('✅ ALL CRITICAL CHECKS PASSED!');
        console.log('\n📋 Next Steps:');
        console.log('   1. Start server: node server.js');
        console.log('   2. Get public URL: ngrok http 3000');
        console.log('   3. Set webhook in Twilio console');
        console.log('   4. Send "ZAMZAM" to test');
    } else {
        console.log('❌ FIX CRITICAL ISSUES BEFORE STARTING BOT');
        console.log('\n📋 Action Required:');
        console.log('   1. Review failed checks above');
        console.log('   2. Update .env file');
        console.log('   3. Check database setup');
        console.log('   4. Run: node diagnose.js again');
    }
    console.log('='.repeat(50) + '\n');
}

async function runDiagnostics() {
    console.log('\n🔧 WhatsApp Bot Diagnostic Tool');
    console.log('🔧 Checking all systems...\n');

    await checkEnvironment();
    await checkDatabase();
    await checkTwilio();
    await checkPayment();
    await checkGoogleSheets();
    await checkRestaurantData();

    printSummary();
}

runDiagnostics().catch(error => {
    console.error('\n💥 Diagnostic tool crashed:', error);
    process.exit(1);
});
/**
 * ═══════════════════════════════════════════════════════════
 * ENVIRONMENT VALIDATION
 * Validates required environment variables on startup
 * Prevents app from starting with missing configuration
 * ═══════════════════════════════════════════════════════════
 */

const chalk = require('chalk');

// Required environment variables
const REQUIRED_ENV_VARS = [
    'DATABASE_URL',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'WABA_NUMBER',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'BASE_URL',
    'PORT'
];

// Optional but recommended
const RECOMMENDED_ENV_VARS = [
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
    'ADMIN_API_KEY',
    'DEPOSIT_AMOUNT',
    'DEPOSIT_REFUND_HOURS'
];

// Environment-specific requirements
const ENV_SPECIFIC = {
    production: [
        'SENTRY_DSN', // Error tracking
        'WEBHOOK_SECRET' // For webhook verification
    ]
};

/**
 * Validate environment configuration
 */
function validateEnvironment() {
    console.log('\n🔍 Validating Environment Configuration...\n');
    
    let hasErrors = false;
    let hasWarnings = false;
    
    // Check required variables
    console.log('📋 Required Variables:');
    REQUIRED_ENV_VARS.forEach(varName => {
        if (!process.env[varName]) {
            console.log(`   ${chalk.red('✗')} ${varName} - ${chalk.red('MISSING')}`);
            hasErrors = true;
        } else {
            // Mask sensitive values
            const isSensitive = varName.includes('SECRET') || 
                                varName.includes('TOKEN') || 
                                varName.includes('KEY');
            const displayValue = isSensitive 
                ? `${process.env[varName].substring(0, 8)}...` 
                : process.env[varName];
            console.log(`   ${chalk.green('✓')} ${varName} = ${displayValue}`);
        }
    });
    
    // Check recommended variables
    console.log('\n📌 Recommended Variables:');
    RECOMMENDED_ENV_VARS.forEach(varName => {
        if (!process.env[varName]) {
            console.log(`   ${chalk.yellow('⚠')} ${varName} - ${chalk.yellow('Not Set')}`);
            hasWarnings = true;
        } else {
            console.log(`   ${chalk.green('✓')} ${varName}`);
        }
    });
    
    // Check environment-specific requirements
    const nodeEnv = process.env.NODE_ENV || 'development';
    if (ENV_SPECIFIC[nodeEnv]) {
        console.log(`\n🔒 ${nodeEnv.toUpperCase()} Requirements:`);
        ENV_SPECIFIC[nodeEnv].forEach(varName => {
            if (!process.env[varName]) {
                console.log(`   ${chalk.red('✗')} ${varName} - ${chalk.red('MISSING')}`);
                hasErrors = true;
            } else {
                console.log(`   ${chalk.green('✓')} ${varName}`);
            }
        });
    }
    
    // Validate formats
    console.log('\n🔍 Format Validation:');
    
    // DATABASE_URL
    if (process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('postgresql://')) {
        console.log(`   ${chalk.red('✗')} DATABASE_URL - Invalid format (must start with postgresql://)`);
        hasErrors = true;
    } else if (process.env.DATABASE_URL) {
        console.log(`   ${chalk.green('✓')} DATABASE_URL format valid`);
    }
    
    // WABA_NUMBER
    if (process.env.WABA_NUMBER && !process.env.WABA_NUMBER.startsWith('whatsapp:+')) {
        console.log(`   ${chalk.yellow('⚠')} WABA_NUMBER - Should start with 'whatsapp:+' (got: ${process.env.WABA_NUMBER})`);
        hasWarnings = true;
    } else if (process.env.WABA_NUMBER) {
        console.log(`   ${chalk.green('✓')} WABA_NUMBER format valid`);
    }
    
    // BASE_URL
    if (process.env.BASE_URL && !process.env.BASE_URL.startsWith('http')) {
        console.log(`   ${chalk.red('✗')} BASE_URL - Must start with http:// or https://`);
        hasErrors = true;
    } else if (process.env.BASE_URL) {
        console.log(`   ${chalk.green('✓')} BASE_URL format valid`);
    }
    
    // PORT
    const port = parseInt(process.env.PORT);
    if (isNaN(port) || port < 1 || port > 65535) {
        console.log(`   ${chalk.red('✗')} PORT - Invalid port number (${process.env.PORT})`);
        hasErrors = true;
    } else {
        console.log(`   ${chalk.green('✓')} PORT valid (${port})`);
    }
    
    // Summary
    console.log('\n═══════════════════════════════════════════════════════════');
    
    if (hasErrors) {
        console.log(chalk.red('\n❌ VALIDATION FAILED\n'));
        console.log('Missing required environment variables.');
        console.log('Please check your .env file or environment configuration.\n');
        process.exit(1);
    }
    
    if (hasWarnings) {
        console.log(chalk.yellow('\n⚠️  VALIDATION PASSED WITH WARNINGS\n'));
        console.log('Some optional features may not be available.\n');
    } else {
        console.log(chalk.green('\n✅ VALIDATION PASSED\n'));
    }
    
    console.log('═══════════════════════════════════════════════════════════\n');
}

/**
 * Get environment info
 */
function getEnvironmentInfo() {
    return {
        nodeEnv: process.env.NODE_ENV || 'development',
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        hasDatabase: !!process.env.DATABASE_URL,
        hasTwilio: !!process.env.TWILIO_ACCOUNT_SID,
        hasRazorpay: !!process.env.RAZORPAY_KEY_ID,
        hasGoogleSheets: !!(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY)
    };
}

// Run validation on import
if (require.main === module) {
    validateEnvironment();
} else {
    // Auto-validate when imported
    validateEnvironment();
}

module.exports = {
    validateEnvironment,
    getEnvironmentInfo
};

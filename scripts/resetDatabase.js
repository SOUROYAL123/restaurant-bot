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
        rl.question(question, resolve);
    });
}

async function resetDatabase() {
    console.log('⚠️  DATABASE RESET WARNING\n');
    console.log('This will DELETE ALL DATA from your database!\n');
    
    const confirm1 = await prompt('Type "RESET" to continue: ');
    
    if (confirm1 !== 'RESET') {
        console.log('❌ Reset cancelled\n');
        rl.close();
        process.exit(0);
    }
    
    const confirm2 = await prompt('Are you absolutely sure? (yes/no): ');
    
    if (confirm2.toLowerCase() !== 'yes') {
        console.log('❌ Reset cancelled\n');
        rl.close();
        process.exit(0);
    }
    
    try {
        console.log('\n🔄 Resetting database...\n');
        
        // Drop all tables
        await sql`DROP TABLE IF EXISTS customer_interactions CASCADE`;
        await sql`DROP TABLE IF EXISTS pending_messages CASCADE`;
        await sql`DROP TABLE IF EXISTS sessions CASCADE`;
        await sql`DROP TABLE IF EXISTS appointments CASCADE`;
        await sql`DROP TABLE IF EXISTS customers CASCADE`;
        await sql`DROP TABLE IF EXISTS clinics CASCADE`;
        
        console.log('✅ All tables dropped\n');
        console.log('🔄 Recreating schema...\n');
        
        // Reinitialize
        const { execSync } = require('child_process');
        execSync('npm run db:init', { stdio: 'inherit' });
        
        console.log('\n✅ Database reset complete!\n');
        
        rl.close();
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Reset failed:', error.message);
        rl.close();
        process.exit(1);
    }
}

resetDatabase();

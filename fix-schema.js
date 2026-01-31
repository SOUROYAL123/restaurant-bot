// fix-schema.js - Automatically fix missing database columns
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function fixSchema() {
    console.log('🔧 Checking and fixing database schema...\n');
    
    try {
        const client = await pool.connect();
        
        // Check current columns
        console.log('📋 Current restaurant table columns:');
        const columns = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'restaurants'
            ORDER BY ordinal_position
        `);
        
        columns.rows.forEach(col => {
            console.log(`   - ${col.column_name} (${col.data_type})`);
        });
        
        console.log('\n🔨 Applying fixes...\n');
        
        // Add 'active' column if missing
        const hasActive = columns.rows.some(col => col.column_name === 'active');
        if (!hasActive) {
            await client.query(`
                ALTER TABLE restaurants 
                ADD COLUMN active BOOLEAN DEFAULT true
            `);
            await client.query(`UPDATE restaurants SET active = true`);
            console.log('✅ Added "active" column');
        } else {
            console.log('✅ "active" column already exists');
            // Make sure all are active
            await client.query(`UPDATE restaurants SET active = true WHERE active IS NULL`);
        }
        
        // Add 'owner_name' column if missing (optional but useful)
        const hasOwnerName = columns.rows.some(col => col.column_name === 'owner_name');
        if (!hasOwnerName) {
            await client.query(`
                ALTER TABLE restaurants 
                ADD COLUMN owner_name VARCHAR(100)
            `);
            console.log('✅ Added "owner_name" column (optional)');
        } else {
            console.log('✅ "owner_name" column already exists');
        }
        
        // Verify restaurants
        console.log('\n📊 Current restaurants:');
        const restaurants = await client.query(`
            SELECT id, name, phone, active, owner_name 
            FROM restaurants 
            ORDER BY id
        `);
        
        if (restaurants.rows.length === 0) {
            console.log('⚠️  No restaurants found in database!');
        } else {
            restaurants.rows.forEach(r => {
                const status = r.active ? '✅ ACTIVE' : '❌ INACTIVE';
                const owner = r.owner_name || 'Not set';
                console.log(`   ${r.id}. ${r.name} - ${status} - Owner: ${owner}`);
            });
        }
        
        client.release();
        await pool.end();
        
        console.log('\n✅ Schema fix completed successfully!');
        console.log('\n📋 Next steps:');
        console.log('   1. Run: node diagnose.js (should now pass all checks)');
        console.log('   2. Run: node server.js');
        console.log('   3. Start ngrok and set webhook');
        
    } catch (error) {
        console.error('❌ Schema fix failed:', error.message);
        await pool.end();
        process.exit(1);
    }
}

fixSchema();
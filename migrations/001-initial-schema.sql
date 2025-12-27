// migrations/runMigration.js
require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const fs = require('fs');

const sql = neon(process.env.DATABASE_URL);

async function runMigration() {
    try {
        const migration = fs.readFileSync('./migrations/001-initial-schema.sql', 'utf8');
        await sql(migration);
        console.log('✅ Migration completed successfully');
    } catch (error) {
        console.error('❌ Migration failed:', error);
    }
}

runMigration();

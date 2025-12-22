// fix-doctor-column.js
require('dotenv').config();
const db = require('./db');

async function fixColumn() {
    try {
        console.log('⏳ Fixing doctors table...');
        
        // Increase whatsapp column size
        await db.query(`
            ALTER TABLE doctors 
            ALTER COLUMN whatsapp TYPE VARCHAR(50)
        `);
        
        console.log('✅ Column size increased');
        console.log('');
        console.log('Now run: node setup-doctor.js');
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

fixColumn();

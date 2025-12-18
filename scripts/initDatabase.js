require('dotenv').config();
const db = require('../config/database');
const fs = require('fs');
const path = require('path');

async function initializeDatabase() {
    try {
        console.log('🔄 Initializing database...');
        
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        
        await db.query(schema);
        
        console.log('✅ Database initialized successfully');
        process.exit(0);
    } catch (error) {
        console.error('❌ Database initialization failed:', error);
        process.exit(1);
    }
}

initializeDatabase();

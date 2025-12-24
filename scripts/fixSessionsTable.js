require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function fixSessionsTable() {
    try {
        console.log('🔧 Checking sessions table schema...\n');
        
        // Check current columns
        const columns = await sql`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'sessions'
            ORDER BY ordinal_position
        `;
        
        console.log('Current columns:');
        columns.forEach(col => {
            console.log(`  - ${col.column_name} (${col.data_type})`);
        });
        
        // Check if last_activity exists
        const hasLastActivity = columns.some(col => col.column_name === 'last_activity');
        
        if (!hasLastActivity) {
            console.log('\n⚠️  Missing last_activity column, adding it...\n');
            
            // Add the column
            await sql`
                ALTER TABLE sessions 
                ADD COLUMN last_activity TIMESTAMP DEFAULT NOW()
            `;
            
            // Update existing rows
            await sql`
                UPDATE sessions 
                SET last_activity = COALESCE(updated_at, created_at, NOW())
            `;
            
            // Add index
            await sql`
                CREATE INDEX IF NOT EXISTS idx_sessions_last_activity 
                ON sessions(last_activity)
            `;
            
            console.log('✅ Added last_activity column');
            console.log('✅ Updated existing rows');
            console.log('✅ Created index\n');
        } else {
            console.log('\n✅ last_activity column already exists\n');
        }
        
        // Show final schema
        const finalColumns = await sql`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns 
            WHERE table_name = 'sessions'
            ORDER BY ordinal_position
        `;
        
        console.log('Final schema:');
        finalColumns.forEach(col => {
            console.log(`  - ${col.column_name} (${col.data_type}) ${col.column_default || ''}`);
        });
        
        console.log('\n✅ Sessions table fixed successfully!\n');
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error fixing sessions table:', error);
        process.exit(1);
    }
}

fixSessionsTable();

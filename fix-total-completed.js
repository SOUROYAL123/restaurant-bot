require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function fixMissingColumn() {
    try {
        console.log('🔧 Adding missing total_completed column...\n');
        
        // Add the column
        await sql`
            ALTER TABLE customers 
            ADD COLUMN IF NOT EXISTS total_completed INTEGER DEFAULT 0
        `;
        
        console.log('✅ Column added\n');
        
        // Update existing rows
        await sql`
            UPDATE customers 
            SET total_completed = 0 
            WHERE total_completed IS NULL
        `;
        
        console.log('✅ Existing rows updated\n');
        
        // Create index
        await sql`
            CREATE INDEX IF NOT EXISTS idx_customers_completed 
            ON customers(total_completed)
        `;
        
        console.log('✅ Index created\n');
        
        // Verify
        const columns = await sql`
            SELECT column_name, data_type, column_default 
            FROM information_schema.columns 
            WHERE table_name = 'customers' 
            AND column_name = 'total_completed'
        `;
        
        if (columns.length > 0) {
            console.log('✅ VERIFICATION SUCCESSFUL:');
            console.log(columns[0]);
        } else {
            console.log('❌ Column not found - something went wrong');
        }
        
        console.log('\n🎉 Fix complete! Restart your bot to apply changes.');
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

fixMissingColumn();
